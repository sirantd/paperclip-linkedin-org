import type { EnvSecretRefBinding, PluginContext, ScopeKey } from "@paperclipai/plugin-sdk";
import { openToken, sealToken } from "./crypto.js";
import { buildAuthorizationUrl, exchangeCode, refreshTokens, type LinkedInTokens } from "./adapters/linkedin/auth.js";
import { listAdministeredPages, type AdministeredPage } from "./adapters/linkedin/orgs.js";
import {
  REQUESTED_SCOPES,
  grantedScopes,
  missingScopes,
  type PageAction,
} from "./adapters/linkedin/scopes.js";
import { LinkedInApiError, LinkedInOAuthError } from "./adapters/linkedin/errors.js";

export type PageConnectionStatus = "active" | "expired" | "revoked";

/** The Page one tool call acts as, with an access token that is valid now. */
export interface ActingPage {
  organizationId: string;
  organizationUrn: string;
  /** The Page name, or the organization URN when LinkedIn gave no name. */
  displayName: string;
  accessToken: string;
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
 * The Page connections of each company: connect, act as a Page, list and
 * disconnect. Credentials, Page selection, token refresh and expiry, sealing
 * and storage stay behind this interface. Errors carry operator-facing text.
 */
export interface PageConnections {
  /**
   * Choose the acting Page and run `work` as it with a fresh access token. The
   * Page is the named one, else the default Page, else the only active Page.
   * A Page connection without a scope that `action` needs refuses the action.
   * If LinkedIn rejects the token (401), the Page connection becomes expired.
   */
  actAs<T>(
    companyId: string,
    organizationId: string | undefined,
    action: PageAction,
    work: (page: ActingPage) => Promise<T>,
  ): Promise<T>;
  /** Every Page connection of the company, in any status, by name with unnamed Pages last. */
  list(companyId: string): Promise<PageSummary[]>;
  /** Begin connect: remember an OAuth state and return the LinkedIn authorization URL. */
  startConnect(
    companyId: string,
    operatorId: string,
  ): Promise<{ authorizationUrl: string; scopes: readonly string[] }>;
  /** Finish connect: one active Page connection for each Page the authorizing member administers. */
  finishConnect(companyId: string, code: string, state: string, operatorId: string): Promise<AdministeredPage[]>;
  disconnect(companyId: string, organizationId: string): Promise<void>;
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
  defaultOrganizationId: string | null;
}

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
  expires_at: string;
}

/** Refresh a little before actual expiry so a long-running post never races the deadline. */
const REFRESH_SKEW_MS = 5 * 60 * 1000;

/** An OAuth state older than this is refused; the operator must start connect again. */
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

export function createPageConnections(ctx: PluginContext): PageConnections {
  /** The refresh in progress for each Page connection, by row id; concurrent calls share it. */
  const refreshes = new Map<string, Promise<string>>();

  return {
    async actAs(companyId, organizationId, action, work) {
      const creds = await loadCredentials(ctx, companyId);
      const row = await findConnection(ctx, companyId, organizationId ?? creds.defaultOrganizationId);
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
          accessToken,
        });
      } catch (err) {
        if (!(err instanceof LinkedInApiError && err.status === 401)) throw err;
        await markExpired(ctx, row.id);
        throw new Error(
          `LinkedIn rejected the token for Page ${row.organization_id} (${err.message}). Reconnect the Page in Settings.`,
        );
      }
    },

    async list(companyId) {
      const rows = await ctx.db.query<PageConnectionRow>(
        `select organization_id, organization_urn, page_name, vanity_name, status, expires_at
           from ${table(ctx)} where company_id = $1 order by page_name nulls last`,
        [companyId],
      );
      return rows.map((r) => ({
        organizationId: r.organization_id,
        organizationUrn: r.organization_urn,
        name: r.page_name,
        vanityName: r.vanity_name,
        displayName: r.page_name ?? r.organization_urn,
        status: r.status,
        expiresAt: new Date(r.expires_at).toISOString(),
      }));
    },

    async startConnect(companyId, operatorId) {
      const creds = await loadCredentials(ctx, companyId);
      const state = crypto.randomUUID();
      await ctx.state.set(oauthStateKey(companyId, state), { createdAt: Date.now(), actorId: operatorId });
      return {
        authorizationUrl: buildAuthorizationUrl({
          clientId: creds.clientId,
          redirectUri: creds.redirectUri,
          state,
        }),
        scopes: REQUESTED_SCOPES,
      };
    },

    finishConnect(companyId, code, state, operatorId) {
      return completeOAuth(ctx, companyId, code, state, operatorId);
    },

    async disconnect(companyId, organizationId) {
      await ctx.db.execute(
        `update ${table(ctx)} set status = 'revoked', access_token_sealed = '', refresh_token_sealed = null, updated_at = now()
          where company_id = $1 and organization_id = $2`,
        [companyId, organizationId],
      );
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
      `/api/plugins/sirantd.linkedin-org/api/oauth/callback?companyId=${companyId}`,
    defaultOrganizationId: config.defaultOrganizationUrn
      ? (config.defaultOrganizationUrn.split(":").pop() ?? null)
      : null,
  };
}

function table(ctx: PluginContext): string {
  return `${ctx.db.namespace}.page_connections`;
}

async function findConnection(
  ctx: PluginContext,
  companyId: string,
  organizationId: string | null,
): Promise<PageConnectionRow> {
  const rows = organizationId
    ? await ctx.db.query<PageConnectionRow>(
        `select * from ${table(ctx)} where company_id = $1 and organization_id = $2 and status = 'active'`,
        [companyId, organizationId],
      )
    : await ctx.db.query<PageConnectionRow>(
        `select * from ${table(ctx)} where company_id = $1 and status = 'active' order by created_at asc limit 2`,
        [companyId],
      );

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

  await ctx.db.execute(
    `update ${table(ctx)}
        set access_token_sealed = $1,
            refresh_token_sealed = coalesce($2, refresh_token_sealed),
            expires_at = $3,
            last_refreshed_at = now(),
            updated_at = now()
      where id = $4`,
    [
      sealToken(refreshed.accessToken, creds.dek),
      refreshed.refreshToken ? sealToken(refreshed.refreshToken, creds.dek) : null,
      new Date(refreshed.expiresAt).toISOString(),
      row.id,
    ],
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
 * Exchange an authorization code, check the granted scopes, and upsert one
 * connection row per Page the authorizing member administers.
 */
async function completeOAuth(
  ctx: PluginContext,
  companyId: string,
  code: string,
  state: string,
  actorId: string,
): Promise<AdministeredPage[]> {
  const stateKey = oauthStateKey(companyId, state);
  const pending = (await ctx.state.get(stateKey)) as { createdAt: number } | null;
  if (!pending) throw new Error("Unknown or expired OAuth state");
  if (Date.now() - pending.createdAt > OAUTH_STATE_TTL_MS) {
    await ctx.state.delete(stateKey);
    throw new Error("Unknown or expired OAuth state");
  }

  const creds = await loadCredentials(ctx, companyId);
  const tokens = await exchangeCode(ctx.http, {
    code,
    clientId: creds.clientId,
    clientSecret: creds.clientSecret,
    redirectUri: creds.redirectUri,
  });
  const scopes = grantedScopes(tokens.scope);

  const pages = await listAdministeredPages(ctx.http, tokens.accessToken);
  if (pages.length === 0) {
    throw new Error(
      "The authorizing member does not administer any LinkedIn Page. " +
        "Grant them an ADMINISTRATOR role on the Page and reconnect.",
    );
  }

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
          actorId,
          null, // member URN unavailable without the openid scope
          scopes.join(","),
          sealToken(tokens.accessToken, creds.dek),
          tokens.refreshToken ? sealToken(tokens.refreshToken, creds.dek) : null,
          new Date(tokens.expiresAt).toISOString(),
          tokens.refreshTokenExpiresAt ? new Date(tokens.refreshTokenExpiresAt).toISOString() : null,
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
    throw new Error(
      "Connected to LinkedIn but could not store the connection. See the plugin logs for the database error.",
    );
  }

  await ctx.state.delete(stateKey);

  return pages;
}

function oauthStateKey(companyId: string, state: string): ScopeKey {
  return { scopeKind: "company", scopeId: companyId, stateKey: `oauth:${state}` };
}
