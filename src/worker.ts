import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import type {
  PluginContext,
  PluginApiRequestInput,
  PluginApiResponse,
  EnvSecretRefBinding,
} from "@paperclipai/plugin-sdk";
import { openToken, sealToken } from "./crypto.js";
import {
  assertOrgScopesGranted,
  buildAuthorizationUrl,
  exchangeCode,
  refreshTokens,
  type LinkedInTokens,
} from "./adapters/linkedin/auth.js";
import { listAdministeredPages } from "./adapters/linkedin/orgs.js";
import {
  commentAsOrganization,
  publishAsOrganization,
  reactAsOrganization,
} from "./adapters/linkedin/publish.js";
import { LINKEDIN_ORG_SCOPES } from "./adapters/linkedin/constants.js";

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
  status: string;
  scopes: string[];
  access_token_sealed: string;
  refresh_token_sealed: string | null;
  expires_at: string;
}

/** Refresh a little before actual expiry so a long-running post never races the deadline. */
const REFRESH_SKEW_MS = 5 * 60 * 1000;

/**
 * The host hands the live PluginContext to setup() only; onApiRequest() is a
 * sibling lifecycle hook with no ctx argument, so setup() parks it here for the
 * route handlers to use.
 */
let sharedCtx: PluginContext | null = null;

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
): Promise<string> {
  const expiresAt = new Date(row.expires_at).getTime();
  if (Date.now() < expiresAt - REFRESH_SKEW_MS) {
    return openToken(row.access_token_sealed, creds.dek);
  }

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
    await markExpired(ctx, row.id);
    throw new Error(
      `Refreshing the LinkedIn token for Page ${row.organization_id} failed (${(err as Error).message}). Reconnect the Page in Settings.`,
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

const plugin = definePlugin({
  async setup(ctx: PluginContext) {
    sharedCtx = ctx;
    ctx.logger.info("LinkedIn Page plugin starting");

    ctx.tools.register(
      "linkedin-page-list",
      {
        displayName: "List LinkedIn Pages",
        description:
          "List the company LinkedIn Pages connected to Paperclip that agents can publish as.",
        parametersSchema: { type: "object", properties: {} },
      },
      async (_params, run) => {
        const rows = await ctx.db.query<PageConnectionRow>(
          `select organization_id, organization_urn, page_name, vanity_name, status
             from ${table(ctx)} where company_id = $1 order by page_name nulls last`,
          [run.companyId],
        );
        return {
          content: rows.length
            ? rows
                .map((r) => `${r.page_name ?? r.organization_urn} (${r.organization_id}) — ${r.status}`)
                .join("\n")
            : "No LinkedIn Pages are connected for this company.",
          data: rows,
        };
      },
    );

    ctx.tools.register(
      "linkedin-page-post",
      {
        displayName: "Post as LinkedIn Page",
        description:
          "Publish a post authored by the company LinkedIn Page. The post is public and immediately live — do not call this to draft or preview.",
        parametersSchema: {
          type: "object",
          required: ["text"],
          properties: {
            text: { type: "string", description: "Post body. Plain text; LinkedIn renders line breaks." },
            organizationId: {
              type: "string",
              description: "Numeric organization id. Optional when exactly one Page is connected.",
            },
            visibility: { type: "string", enum: ["PUBLIC", "LOGGED_IN"], default: "PUBLIC" },
          },
        },
      },
      async (params, run) => {
        const p = params as { text: string; organizationId?: string; visibility?: "PUBLIC" | "LOGGED_IN" };
        try {
          const creds = await loadCredentials(ctx, run.companyId);
          const row = await findConnection(ctx, run.companyId, p.organizationId ?? creds.defaultOrganizationId);
          const token = await accessTokenFor(ctx, run.companyId, creds, row);
          const result = await publishAsOrganization(ctx.http, {
            accessToken: token,
            organizationId: row.organization_id,
            text: p.text,
            visibility: p.visibility,
          });
          await ctx.activity.log({
            companyId: run.companyId,
            message: `Posted as ${row.page_name ?? row.organization_urn}`,
            entityType: "linkedin_page_post",
            entityId: result.postUrn,
            metadata: {
              postUrn: result.postUrn,
              organizationId: row.organization_id,
              agentId: run.agentId,
              runId: run.runId,
            },
          });
          return {
            content: `Published as ${row.page_name ?? row.organization_urn}: ${result.permalink ?? result.postUrn}`,
            data: result,
          };
        } catch (err) {
          return { error: (err as Error).message };
        }
      },
    );

    ctx.tools.register(
      "linkedin-page-react",
      {
        displayName: "React as LinkedIn Page",
        description: "React to a LinkedIn post as the company Page.",
        parametersSchema: {
          type: "object",
          required: ["postUrn"],
          properties: {
            postUrn: { type: "string", description: "urn:li:activity:… / urn:li:share:… / urn:li:ugcPost:…" },
            organizationId: { type: "string" },
            reactionType: {
              type: "string",
              enum: ["LIKE", "PRAISE", "EMPATHY", "INTEREST", "APPRECIATION"],
              default: "LIKE",
            },
          },
        },
      },
      async (params, run) => {
        const p = params as { postUrn: string; organizationId?: string; reactionType?: never };
        try {
          const creds = await loadCredentials(ctx, run.companyId);
          const row = await findConnection(ctx, run.companyId, p.organizationId ?? creds.defaultOrganizationId);
          const token = await accessTokenFor(ctx, run.companyId, creds, row);
          await reactAsOrganization(ctx.http, {
            accessToken: token,
            organizationId: row.organization_id,
            postUrn: p.postUrn,
            reactionType: p.reactionType,
          });
          return { content: `Reacted to ${p.postUrn} as ${row.page_name ?? row.organization_urn}.` };
        } catch (err) {
          return { error: (err as Error).message };
        }
      },
    );

    ctx.tools.register(
      "linkedin-page-comment",
      {
        displayName: "Comment as LinkedIn Page",
        description: "Comment on a LinkedIn post as the company Page.",
        parametersSchema: {
          type: "object",
          required: ["postUrn", "text"],
          properties: {
            postUrn: { type: "string" },
            text: { type: "string" },
            organizationId: { type: "string" },
          },
        },
      },
      async (params, run) => {
        const p = params as { postUrn: string; text: string; organizationId?: string };
        try {
          const creds = await loadCredentials(ctx, run.companyId);
          const row = await findConnection(ctx, run.companyId, p.organizationId ?? creds.defaultOrganizationId);
          const token = await accessTokenFor(ctx, run.companyId, creds, row);
          await commentAsOrganization(ctx.http, {
            accessToken: token,
            organizationId: row.organization_id,
            postUrn: p.postUrn,
            text: p.text,
          });
          return { content: `Commented on ${p.postUrn} as ${row.page_name ?? row.organization_urn}.` };
        } catch (err) {
          return { error: (err as Error).message };
        }
      },
    );
  },

  async onApiRequest(input: PluginApiRequestInput): Promise<PluginApiResponse> {
    return handleApiRequest(input);
  },
});

export default plugin;

// definePlugin only wraps the definition. runWorker starts the stdio JSON-RPC
// loop the host speaks; without it the worker process evaluates and exits 0.
runWorker(plugin, import.meta.url);

// The host resolves auth, company access and capabilities before calling us,
// so these handlers only deal with plugin-specific validation.

async function handleApiRequest(input: PluginApiRequestInput): Promise<PluginApiResponse> {
  const ctx = sharedCtx;
  if (!ctx) return { status: 503, body: { error: "Plugin worker is still starting" } };

  const companyId = input.companyId;
  try {
    switch (input.routeKey) {
      case "list-pages": {
        const rows = await ctx.db.query(
          `select organization_id, organization_urn, page_name, vanity_name, status, expires_at
             from ${table(ctx)} where company_id = $1 order by page_name nulls last`,
          [companyId],
        );
        return { status: 200, body: { pages: rows } };
      }

      case "oauth-start": {
        const creds = await loadCredentials(ctx, companyId);
        const state = crypto.randomUUID();
        await ctx.state.set(
          { scopeKind: "company", scopeId: companyId, stateKey: `oauth:${state}` },
          { createdAt: Date.now(), actorId: input.actor.actorId },
        );
        return {
          status: 200,
          body: {
            authorizationUrl: buildAuthorizationUrl({
              clientId: creds.clientId,
              redirectUri: creds.redirectUri,
              state,
            }),
            scopes: LINKEDIN_ORG_SCOPES,
          },
        };
      }

      case "oauth-callback": {
        const code = String(input.query.code ?? "");
        const state = String(input.query.state ?? "");
        const oauthError = input.query.error ? String(input.query.error) : null;
        if (oauthError) {
          return callbackResult(400,
            "LinkedIn authorization was declined",
            `${oauthError}: ${String(input.query.error_description ?? "")}`,
          );
        }
        if (!code || !state) {
          return callbackResult(400, "Missing code or state", "LinkedIn did not return an authorization code.");
        }
        try {
          const connected = await completeOAuth(ctx, companyId, code, state, input.actor.actorId);
          return callbackResult(200,
            "LinkedIn Page connected",
            `Connected: ${connected.map((p) => p.name ?? p.organizationUrn).join(", ")}. You can close this tab.`,
          );
        } catch (err) {
          return callbackResult(400, "Could not connect the Page", (err as Error).message);
        }
      }

      case "oauth-complete": {
        const body = (input.body ?? {}) as { code?: string; state?: string };
        if (!body.code || !body.state) {
          return { status: 400, body: { error: "code and state are required" } };
        }
        const connected = await completeOAuth(
          ctx,
          companyId,
          body.code,
          body.state,
          input.actor.actorId,
        );
        return { status: 200, body: { connected } };
      }

      case "disconnect": {
        const organizationId = input.params.organizationId;
        await ctx.db.execute(
          `update ${table(ctx)} set status = 'revoked', access_token_sealed = '', refresh_token_sealed = null, updated_at = now()
            where company_id = $1 and organization_id = $2`,
          [companyId, organizationId],
        );
        return { status: 200, body: { disconnected: organizationId } };
      }

      default:
        return { status: 404, body: { error: `Unknown route ${input.routeKey}` } };
    }
  } catch (err) {
    ctx.logger.error("LinkedIn Page API request failed", {
      routeKey: input.routeKey,
      error: (err as Error).message,
    });
    return { status: 500, body: { error: (err as Error).message } };
  }
}

/**
 * Exchange an authorization code, verify org scopes were actually granted, and
 * upsert one connection row per Page the authorizing member administers.
 * Shared by the browser GET callback and the programmatic POST route.
 */
async function completeOAuth(
  ctx: PluginContext,
  companyId: string,
  code: string,
  state: string,
  actorId: string,
) {
  const pending = await ctx.state.get({
    scopeKind: "company",
    scopeId: companyId,
    stateKey: `oauth:${state}`,
  });
  if (!pending) throw new Error("Unknown or expired OAuth state");

  const creds = await loadCredentials(ctx, companyId);
  const tokens = await exchangeCode(ctx.http, {
    code,
    clientId: creds.clientId,
    clientSecret: creds.clientSecret,
    redirectUri: creds.redirectUri,
  });
  assertOrgScopesGranted(tokens);

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
          (tokens.scope ?? LINKEDIN_ORG_SCOPES.join(" ")).split(/[\s,]+/).filter(Boolean).join(","),
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

  await ctx.state.delete({
    scopeKind: "company",
    scopeId: companyId,
    stateKey: `oauth:${state}`,
  });

  return pages;
}

/**
 * Result for the browser redirect leg of OAuth.
 *
 * The host always sends `body` through res.json() and its response-header
 * allowlist covers only cache-control/etag/last-modified/x-request-id, so a
 * plugin route can return neither HTML nor a 302. The operator sees this JSON.
 */
function callbackResult(status: number, outcome: string, detail: string): PluginApiResponse {
  return { status, body: { outcome, detail } };
}

