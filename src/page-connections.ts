import type { EnvSecretRefBinding, PluginContext, ScopeKey } from "@paperclipai/plugin-sdk";
import { openToken, sealToken } from "./crypto.js";
import { buildAuthorizationUrl, exchangeCode, refreshTokens, type LinkedInTokens } from "./adapters/linkedin/auth.js";
import { listAdministeredPages, organizationIdOf, type AdministeredPage } from "./adapters/linkedin/orgs.js";
import {
  REQUESTED_SCOPES,
  grantedScopes,
  missingScopes,
  type PageAction,
} from "./adapters/linkedin/scopes.js";
import { LinkedInApiError, LinkedInOAuthError } from "./adapters/linkedin/errors.js";
import { linkedInPage, type FileTransport, type PageCalls } from "./adapters/linkedin/page.js";
import manifest from "./manifest.js";

export type PageConnectionStatus = "active" | "expired" | "revoked";

/**
 * The Page one tool call acts as, and the LinkedIn calls it makes with an
 * access token that is valid now. It is valid only inside the work of actAs:
 * a call after the work can use a stale token, and actAs no longer sees its
 * errors.
 */
export interface ActingPage extends PageCalls {
  organizationId: string;
  organizationUrn: string;
  /** The Page name, or the organization URN when LinkedIn gave no name. */
  displayName: string;
}

export interface PageSummary {
  organizationId: string;
  organizationUrn: string;
  name: string | null;
  vanityName: string | null;
  /** The Page name, or the organization URN when LinkedIn gave no name. */
  displayName: string;
  status: PageConnectionStatus;
  /** ISO 8601 expiry of the stored access token. */
  expiresAt: string;
}

/**
 * The fields of the LinkedIn redirect to the redirect URI: `code` and `state`
 * after an approval, `error`, `error_description` and `state` after a refusal.
 * A value that is not one string counts as absent.
 */
export type LinkedInRedirect = Readonly<Partial<Record<"code" | "state" | "error" | "error_description", unknown>>>;

/**
 * Why connect made no Page connection. The operator can remove the cause of
 * the first six and connect again. The last two are faults of LinkedIn or of
 * the plugin.
 */
export type ConnectRefusal =
  /** LinkedIn sent an error: the authorizing member declined, or LinkedIn refused the authorization. */
  | "declined"
  /** The redirect has no authorization code or no OAuth state. */
  | "incomplete_redirect"
  /** The OAuth state is unknown, expired or used, or a different operator started connect. */
  | "invalid_state"
  /** LinkedIn refused the authorization code: it expired or was used. */
  | "code_refused"
  /** LinkedIn did not grant the needed scopes, or did not report the granted scopes. */
  | "grant_refused"
  /** The authorizing member administers no Page. */
  | "no_page"
  /** The token endpoint or a LinkedIn call failed. A refused Client ID or Client Secret is plugin_failed. */
  | "linkedin_failed"
  /** The plugin settings (a Client ID or a Client Secret that LinkedIn refused too), the DEK or the database failed. */
  | "plugin_failed";

/** The result of one finish of connect: the connected Pages, or a refusal with operator-facing text. */
export type ConnectOutcome =
  | { kind: "connected"; pages: AdministeredPage[] }
  | { kind: ConnectRefusal; reason: string };

/**
 * The Page connections of each company: connect, act as a Page, list and
 * disconnect. Credentials, Page selection, token refresh and expiry, sealing
 * and storage stay behind this interface. Errors and connect refusals carry
 * operator-facing text.
 * An organization reference names a Page by its organization id or its
 * Organization URN; this interface reads it into the organization id once.
 */
export interface PageConnections {
  /**
   * Choose the acting Page and run `work` with it. The acting Page makes the
   * LinkedIn calls with a fresh access token; the token stays behind this
   * interface. The Page is the one that `organizationRef` names, else the
   * default Page, else the only active Page.
   * A Page connection without a scope that `action` needs refuses the action.
   * If LinkedIn rejects the token (401), the Page connection becomes expired.
   * A refusal (403) or a rate limit (429) keeps it active, with text that names
   * the action and the Page.
   */
  actAs<T>(
    companyId: string,
    organizationRef: string | undefined,
    action: PageAction,
    work: (page: ActingPage) => Promise<T>,
  ): Promise<T>;
  /** Every Page connection of the company, in any status, by name with unnamed Pages last. */
  list(companyId: string): Promise<PageSummary[]>;
  /** Begin connect: remember an OAuth state for the operator and return the LinkedIn authorization URL. */
  startConnect(
    companyId: string,
    operatorId: string,
  ): Promise<{ authorizationUrl: string; scopes: readonly string[] }>;
  /**
   * Finish connect with the redirect as LinkedIn sent it. The first finish of
   * an OAuth state uses it up, whatever the outcome. Only the operator who
   * started connect can finish it. If connect succeeds, each Page that the
   * authorizing member administers has one active Page connection.
   */
  finishConnect(companyId: string, redirect: LinkedInRedirect, operatorId: string): Promise<ConnectOutcome>;
  /**
   * Revoke the Page connection of the Page that `organizationRef` names, in
   * any status. False if the company has no Page connection for that Page.
   */
  disconnect(companyId: string, organizationRef: string): Promise<boolean>;
}

/**
 * Secret fields hold the host binding form ({ type: "secret_ref", secretId }).
 * A bare UUID string is rejected on save as a legacy form.
 */
interface PluginConfigShape {
  dekRef: EnvSecretRefBinding;
  redirectBaseUrl: string;
  clientIdRef: EnvSecretRefBinding;
  clientSecretRef: EnvSecretRefBinding;
  defaultOrganizationUrn?: string;
}

interface Credentials {
  dek: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  /** The organization reference of the default Page, as the operator set it. */
  defaultOrganizationRef: string | null;
}

/**
 * A stored Page connection after readRow: each value has one form. The tokens
 * stay sealed under the DEK until a step opens them.
 */
interface PageConnectionRow {
  id: string;
  organization_id: string;
  organization_urn: string;
  page_name: string | null;
  vanity_name: string | null;
  status: PageConnectionStatus;
  scopes: string[];
  access_token_sealed: string;
  refresh_token_sealed: string | null;
  /** ISO 8601 expiry of the stored access token. */
  expires_at: string;
}

/**
 * A row as ctx.db.query returns it. The host sends rows through JSON-RPC in
 * the form that its driver gives: a timestamp as a Date or as text, and a
 * text[] value as an array or as Postgres array text (`{a,b}`).
 */
type StoredRow = Omit<PageConnectionRow, "scopes" | "expires_at"> & { scopes: unknown; expires_at: unknown };

/** The columns of PageConnectionRow; every read of a Page connection selects them. */
const COLUMNS =
  "id, organization_id, organization_urn, page_name, vanity_name, status, scopes, " +
  "access_token_sealed, refresh_token_sealed, expires_at";

/** Refresh a little before actual expiry so a long-running post never races the deadline. */
const REFRESH_SKEW_MS = 5 * 60 * 1000;

/** An OAuth state older than this is refused; the operator must start connect again. */
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

/** What startConnect stores for an OAuth state until its first finish. */
interface PendingConnect {
  createdAt: number;
  /** The operator who started connect. */
  actorId: string;
}

/** The refusals that are faults of LinkedIn or of the plugin; finishConnect logs them. */
const CONNECT_FAULTS: ReadonlySet<ConnectRefusal> = new Set(["linkedin_failed", "plugin_failed"]);

export function createPageConnections(ctx: PluginContext, fileTransport?: FileTransport): PageConnections {
  /** The refresh in progress for each Page connection, by row id; concurrent calls share it. */
  const refreshes = new Map<string, Promise<string>>();

  return {
    async actAs(companyId, organizationRef, action, work) {
      const creds = await loadCredentials(ctx, companyId);
      const row = await findConnection(ctx, companyId, chosenOrganizationId(organizationRef, creds));
      const missing = missingScopes(row.scopes, action);
      if (missing.length > 0) {
        throw new Error(
          `Page ${row.organization_id} was connected without ${missing.join(", ")}, which ${action} needs. ` +
            "Reconnect the Page in Settings.",
        );
      }
      const accessToken = await accessTokenFor(ctx, companyId, creds, row, refreshes);
      try {
        return await work({
          organizationId: row.organization_id,
          organizationUrn: row.organization_urn,
          displayName: row.page_name ?? row.organization_urn,
          ...linkedInPage(ctx.http, { accessToken, organizationUrn: row.organization_urn }, fileTransport),
        });
      } catch (err) {
        if (!(err instanceof LinkedInApiError)) throw err;
        switch (err.kind) {
          case "token_rejected":
            await markExpired(ctx, row.id);
            throw new Error(
              `LinkedIn rejected the token for Page ${row.organization_id} (${err.message}). Reconnect the Page in Settings.`,
            );
          case "access_denied":
            throw new Error(
              `LinkedIn refused ${action} as Page ${row.organization_id} (${err.message}). ` +
                `The Page connection holds the scopes that the plugin requires for ${action}, so the authorizing ` +
                "member may no longer administer the Page, or LinkedIn may have withdrawn the app's access. " +
                "Check both, then reconnect the Page in Settings.",
            );
          case "rate_limited":
            throw new Error(
              `LinkedIn refused ${action} as Page ${row.organization_id} because of its rate limit (${err.message}). ` +
                "Try again later.",
            );
          default:
            // A version sunset already names its fix; other errors carry the LinkedIn text.
            throw err;
        }
      }
    },

    async list(companyId) {
      const rows = await selectConnections(ctx, "company_id = $1 order by page_name nulls last", [companyId]);
      return rows.map((r) => ({
        organizationId: r.organization_id,
        organizationUrn: r.organization_urn,
        name: r.page_name,
        vanityName: r.vanity_name,
        displayName: r.page_name ?? r.organization_urn,
        status: r.status,
        expiresAt: r.expires_at,
      }));
    },

    async startConnect(companyId, operatorId) {
      const creds = await loadCredentials(ctx, companyId);
      const state = crypto.randomUUID();
      const pending: PendingConnect = { createdAt: Date.now(), actorId: operatorId };
      await ctx.state.set(oauthStateKey(companyId, state), pending);
      return {
        authorizationUrl: buildAuthorizationUrl({
          clientId: creds.clientId,
          redirectUri: creds.redirectUri,
          state,
        }),
        scopes: REQUESTED_SCOPES,
      };
    },

    async finishConnect(companyId, redirect, operatorId) {
      const outcome = await completeOAuth(ctx, companyId, redirect, operatorId);
      if (outcome.kind !== "connected" && CONNECT_FAULTS.has(outcome.kind)) {
        ctx.logger.error("LinkedIn Page connect failed", { companyId, kind: outcome.kind, reason: outcome.reason });
      }
      return outcome;
    },

    async disconnect(companyId, organizationRef) {
      const { rowCount } = await ctx.db.execute(
        `update ${table(ctx)} set status = 'revoked', access_token_sealed = '', refresh_token_sealed = null, updated_at = now()
          where company_id = $1 and organization_id = $2`,
        [companyId, requireOrganizationId(organizationRef)],
      );
      return rowCount > 0;
    },
  };
}

async function loadCredentials(ctx: PluginContext, companyId: string): Promise<Credentials> {
  const config = (await ctx.config.get(companyId)) as unknown as PluginConfigShape | null;
  if (!config) {
    throw new Error("LinkedIn Page plugin is not configured for this company");
  }
  const [dek, clientId, clientSecret] = (
    await Promise.all([
      ctx.secrets.resolve(config.dekRef, { companyId, configPath: "dekRef" }),
      ctx.secrets.resolve(config.clientIdRef, { companyId, configPath: "clientIdRef" }),
      ctx.secrets.resolve(config.clientSecretRef, { companyId, configPath: "clientSecretRef" }),
    ])
  ).map((v) => v.trim()) as [string, string, string];
  // Trimmed because secrets pasted through a UI or written by `echo` routinely
  // carry a trailing newline, and LinkedIn answers that with a bare
  // invalid_client that looks identical to a wrong secret.
  return {
    dek,
    clientId,
    clientSecret,
    // Must match the URI registered in the LinkedIn app byte for byte, including
    // the companyId query param — LinkedIn compares before appending code/state.
    redirectUri:
      `${config.redirectBaseUrl.replace(/\/+$/, "")}` +
      `/api/plugins/${manifest.id}/api/oauth/callback?companyId=${companyId}`,
    defaultOrganizationRef: config.defaultOrganizationUrn || null,
  };
}

function table(ctx: PluginContext): string {
  return `${ctx.db.namespace}.page_connections`;
}

/** The Page connections that `clause` selects; it holds the where condition and can add an order and a limit. */
async function selectConnections(
  ctx: PluginContext,
  clause: string,
  params: unknown[],
): Promise<PageConnectionRow[]> {
  const rows = await ctx.db.query<StoredRow>(`select ${COLUMNS} from ${table(ctx)} where ${clause}`, params);
  return rows.map(readRow);
}

function readRow(row: StoredRow): PageConnectionRow {
  return { ...row, scopes: readScopes(row), expires_at: readExpiresAt(row) };
}

/**
 * The scopes as an array. Postgres array text puts quotes only around an
 * element with a special character, and a scope name has none.
 */
function readScopes(row: StoredRow): string[] {
  const { scopes } = row;
  if (Array.isArray(scopes) && scopes.every((scope) => typeof scope === "string")) return scopes;
  if (typeof scopes === "string" && /^\{[^"\\{}]*\}$/.test(scopes)) {
    return scopes.slice(1, -1).split(",").filter(Boolean);
  }
  throw new Error(
    `The stored scopes of Page ${row.organization_id} have a form that the plugin cannot read: ${JSON.stringify(scopes)}.`,
  );
}

function readExpiresAt(row: StoredRow): string {
  const { expires_at: stored } = row;
  const expiresAt = stored instanceof Date || typeof stored === "string" ? new Date(stored) : null;
  if (!expiresAt || Number.isNaN(expiresAt.getTime())) {
    throw new Error(
      `The stored token expiry of Page ${row.organization_id} is not a time: ${JSON.stringify(stored)}.`,
    );
  }
  return expiresAt.toISOString();
}

/** The stored form of the tokens of a grant: sealed under the DEK, with ISO 8601 expiry times. */
function storedTokens(tokens: LinkedInTokens, dek: string) {
  return {
    accessTokenSealed: sealToken(tokens.accessToken, dek),
    refreshTokenSealed: tokens.refreshToken ? sealToken(tokens.refreshToken, dek) : null,
    expiresAt: new Date(tokens.expiresAt).toISOString(),
    refreshExpiresAt: tokens.refreshTokenExpiresAt ? new Date(tokens.refreshTokenExpiresAt).toISOString() : null,
  };
}

function requireOrganizationId(organizationRef: string): string {
  const organizationId = organizationIdOf(organizationRef);
  if (!organizationId) {
    throw new Error(
      `${organizationRef} is not an organization id or an Organization URN (urn:li:organization:{id}).`,
    );
  }
  return organizationId;
}

/**
 * The organization id of the named Page, else of the default Page, else null.
 * Only actAs reads the default Page, so a wrong setting cannot block connect.
 */
function chosenOrganizationId(organizationRef: string | undefined, creds: Credentials): string | null {
  if (organizationRef) return requireOrganizationId(organizationRef);
  if (!creds.defaultOrganizationRef) return null;
  const organizationId = organizationIdOf(creds.defaultOrganizationRef);
  if (!organizationId) {
    throw new Error(
      `The default Page ${creds.defaultOrganizationRef} in the plugin settings is not an organization id ` +
        "or an Organization URN. Correct it in Settings.",
    );
  }
  return organizationId;
}

async function findConnection(
  ctx: PluginContext,
  companyId: string,
  organizationId: string | null,
): Promise<PageConnectionRow> {
  const rows = organizationId
    ? await selectConnections(ctx, "company_id = $1 and organization_id = $2 and status = 'active'", [
        companyId,
        organizationId,
      ])
    : await selectConnections(ctx, "company_id = $1 and status = 'active' order by created_at asc limit 2", [
        companyId,
      ]);

  if (rows.length === 0) {
    throw new Error(
      organizationId
        ? `No active connection for organization ${organizationId}. Connect the Page in Settings first.`
        : "No LinkedIn Page is connected for this company. Connect one in Settings first.",
    );
  }
  // Refuse to guess when several Pages are connected — posting to the wrong
  // company Page is not something an agent should be able to do by omission.
  if (!organizationId && rows.length > 1) {
    throw new Error(
      "Multiple LinkedIn Pages are connected. Pass organizationId explicitly, " +
        "or set a default Page in the plugin settings.",
    );
  }
  return rows[0]!;
}

/**
 * Return a usable access token, refreshing and persisting it when it is at or
 * near expiry. LinkedIn org tokens are typically 60 days, so this path is cold
 * in normal operation but is the difference between a Page that keeps working
 * and one that silently dies two months after setup.
 */
async function accessTokenFor(
  ctx: PluginContext,
  companyId: string,
  creds: Credentials,
  row: PageConnectionRow,
  refreshes: Map<string, Promise<string>>,
): Promise<string> {
  const expiresAt = new Date(row.expires_at).getTime();
  if (Date.now() < expiresAt - REFRESH_SKEW_MS) {
    return openToken(row.access_token_sealed, creds.dek);
  }

  // Two refreshes of one Page connection would race to store their tokens.
  let refresh = refreshes.get(row.id);
  if (!refresh) {
    refresh = refreshAccessToken(ctx, companyId, creds, row).finally(() => refreshes.delete(row.id));
    refreshes.set(row.id, refresh);
  }
  return refresh;
}

async function refreshAccessToken(
  ctx: PluginContext,
  companyId: string,
  creds: Credentials,
  row: PageConnectionRow,
): Promise<string> {
  if (!row.refresh_token_sealed) {
    await markExpired(ctx, row.id);
    throw new Error(
      `LinkedIn token for Page ${row.organization_id} expired and no refresh token is stored. Reconnect the Page in Settings.`,
    );
  }

  let refreshed: LinkedInTokens;
  try {
    refreshed = await refreshTokens(ctx.http, {
      refreshToken: openToken(row.refresh_token_sealed, creds.dek),
      clientId: creds.clientId,
      clientSecret: creds.clientSecret,
    });
  } catch (err) {
    // Only invalid_grant means the refresh token is dead. A network error or a
    // LinkedIn outage passes, and a reconnect cannot fix a wrong Client Secret.
    if (err instanceof LinkedInOAuthError && err.code === "invalid_grant") {
      await markExpired(ctx, row.id);
      throw new Error(
        `Refreshing the LinkedIn token for Page ${row.organization_id} failed (${err.message}). Reconnect the Page in Settings.`,
      );
    }
    throw new Error(
      `Refreshing the LinkedIn token for Page ${row.organization_id} failed (${(err as Error).message}). The Page connection stays active.`,
    );
  }

  const stored = storedTokens(refreshed, creds.dek);
  await ctx.db.execute(
    `update ${table(ctx)}
        set access_token_sealed = $1,
            refresh_token_sealed = coalesce($2, refresh_token_sealed),
            expires_at = $3,
            last_refreshed_at = now(),
            updated_at = now()
      where id = $4`,
    [stored.accessTokenSealed, stored.refreshTokenSealed, stored.expiresAt, row.id],
  );

  ctx.logger.info("refreshed LinkedIn Page token", {
    companyId,
    organizationId: row.organization_id,
  });
  return refreshed.accessToken;
}

function markExpired(ctx: PluginContext, id: string): Promise<{ rowCount: number }> {
  return ctx.db.execute(
    `update ${table(ctx)} set status = 'expired', updated_at = now() where id = $1`,
    [id],
  );
}

/**
 * Use up the OAuth state, exchange the authorization code, check the granted
 * scopes, and upsert one Page connection for each Page that the authorizing
 * member administers. Each step that fails gives its refusal.
 */
async function completeOAuth(
  ctx: PluginContext,
  companyId: string,
  redirect: LinkedInRedirect,
  operatorId: string,
): Promise<ConnectOutcome> {
  const code = redirectField(redirect, "code");
  const state = redirectField(redirect, "state");
  const error = redirectField(redirect, "error");
  const pending = state ? await takePendingConnect(ctx, companyId, state) : null;

  if (error) {
    const description = redirectField(redirect, "error_description");
    return { kind: "declined", reason: description ? `${error}: ${description}` : error };
  }
  if (!code || !state) {
    return {
      kind: "incomplete_redirect",
      reason: "LinkedIn did not return an authorization code and an OAuth state. Start connect again.",
    };
  }
  if (!pending || Date.now() - pending.createdAt > OAUTH_STATE_TTL_MS) {
    return { kind: "invalid_state", reason: "The OAuth state is unknown, expired or used. Start connect again." };
  }
  if (pending.actorId !== operatorId) {
    ctx.logger.warn("LinkedIn Page connect finished by a different operator", {
      companyId,
      startedBy: pending.actorId,
      finishedBy: operatorId,
    });
    return { kind: "invalid_state", reason: "A different operator started this connect. Start connect again." };
  }

  let creds: Credentials;
  try {
    creds = await loadCredentials(ctx, companyId);
  } catch (err) {
    return { kind: "plugin_failed", reason: (err as Error).message };
  }
  try {
    // Examine the DEK before LinkedIn spends the code.
    sealToken("", creds.dek);
  } catch (err) {
    return {
      kind: "plugin_failed",
      reason:
        `The Token Encryption Key (dekRef) cannot seal tokens: ${(err as Error).message}. ` +
        "Correct it in Settings, then connect again.",
    };
  }

  let tokens: LinkedInTokens;
  try {
    tokens = await exchangeCode(ctx.http, {
      code,
      clientId: creds.clientId,
      clientSecret: creds.clientSecret,
      redirectUri: creds.redirectUri,
    });
  } catch (err) {
    if (err instanceof LinkedInOAuthError && err.code === "invalid_grant") {
      return {
        kind: "code_refused",
        reason: `LinkedIn refused the authorization code (${err.message}). Start connect again.`,
      };
    }
    if (err instanceof LinkedInOAuthError && err.code === "invalid_client") {
      // A settings fault: the message of auth.ts names the Client Secret.
      return {
        kind: "plugin_failed",
        reason:
          `LinkedIn refused the client credentials of the plugin (${err.message}). ` +
          "Correct clientIdRef or clientSecretRef in Settings, then connect again.",
      };
    }
    return {
      kind: "linkedin_failed",
      reason: `LinkedIn did not exchange the authorization code (${(err as Error).message}).`,
    };
  }

  let scopes: string[];
  try {
    scopes = grantedScopes(tokens.scope);
  } catch (err) {
    return { kind: "grant_refused", reason: (err as Error).message };
  }

  let pages: AdministeredPage[];
  try {
    pages = await listAdministeredPages(ctx.http, tokens.accessToken);
  } catch (err) {
    // A version sunset already names its fix.
    const sunset = err instanceof LinkedInApiError && err.kind === "version_sunset";
    return {
      kind: "linkedin_failed",
      reason: sunset
        ? (err as Error).message
        : `LinkedIn did not list the Pages that the authorizing member administers (${(err as Error).message}).`,
    };
  }
  if (pages.length === 0) {
    return {
      kind: "no_page",
      reason:
        "The authorizing member does not administer any LinkedIn Page. " +
        "Grant them an ADMINISTRATOR role on the Page and reconnect.",
    };
  }

  const stored = storedTokens(tokens, creds.dek);
  try {
    for (const page of pages) {
      await ctx.db.execute(
        `insert into ${table(ctx)}
           (company_id, organization_urn, organization_id, page_name, vanity_name,
            authorized_by, authorized_member_urn, scopes, status,
            access_token_sealed, refresh_token_sealed, expires_at, refresh_expires_at)
         values ($1,$2,$3,$4,$5,$6,$7,string_to_array($8, ','),'active',$9,$10,$11,$12)
         on conflict (company_id, organization_id) do update set
           page_name = excluded.page_name,
           vanity_name = excluded.vanity_name,
           authorized_by = excluded.authorized_by,
           authorized_member_urn = excluded.authorized_member_urn,
           scopes = excluded.scopes,
           status = 'active',
           access_token_sealed = excluded.access_token_sealed,
           refresh_token_sealed = excluded.refresh_token_sealed,
           expires_at = excluded.expires_at,
           refresh_expires_at = excluded.refresh_expires_at,
           last_refreshed_at = now(),
           updated_at = now()`,
        [
          companyId,
          page.organizationUrn,
          page.organizationId,
          page.name,
          page.vanityName,
          operatorId,
          null, // member URN unavailable without the openid scope
          scopes.join(","),
          stored.accessTokenSealed,
          stored.refreshTokenSealed,
          stored.expiresAt,
          stored.refreshExpiresAt,
        ],
      );
    }
  } catch (err) {
    // A driver error stringifies the whole statement and every bound parameter,
    // sealed token blobs included. Log it plugin-side; hand the caller a summary.
    ctx.logger.error("failed to store LinkedIn Page connection", {
      companyId,
      pageCount: pages.length,
      error: (err as Error).message,
    });
    return {
      kind: "plugin_failed",
      reason: "Connected to LinkedIn but could not store the connection. See the plugin logs for the database error.",
    };
  }

  return { kind: "connected", pages };
}

/** A field of the redirect as one string, or null when it is absent, empty or repeated. */
function redirectField(redirect: LinkedInRedirect, name: keyof LinkedInRedirect): string | null {
  const value = redirect[name];
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * The pending connect of an OAuth state, or null. The state is deleted, so
 * only the first finish can use it. ctx.state has no atomic read and delete:
 * two finishes at the same moment can both read the state, and LinkedIn then
 * refuses the second exchange of the code.
 */
async function takePendingConnect(
  ctx: PluginContext,
  companyId: string,
  state: string,
): Promise<PendingConnect | null> {
  const key = oauthStateKey(companyId, state);
  const pending = (await ctx.state.get(key)) as PendingConnect | null;
  if (pending) await ctx.state.delete(key);
  return pending;
}

function oauthStateKey(companyId: string, state: string): ScopeKey {
  return { scopeKind: "company", scopeId: companyId, stateKey: `oauth:${state}` };
}
