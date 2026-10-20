import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import type {
  PluginContext,
  PluginApiRequestInput,
  PluginApiResponse,
  PluginHttpClient,
} from "@paperclipai/plugin-sdk";
import {
  createPageConnections,
  type PageConnections,
  type PageSummary,
} from "./page-connections.js";
import {
  commentAsOrganization,
  publishAsOrganization,
  reactAsOrganization,
  type PostMedia,
  type ReactionType,
} from "./adapters/linkedin/publish.js";
import {
  ACCEPTED_FILES,
  MAX_MEDIA_BYTES,
  mediaKindForContentType,
  mediaKindOfUrn,
  mediaState,
  requirePostable,
  uploadMedia,
} from "./adapters/linkedin/media.js";
import { LINKEDIN_VERSION, versionWarning } from "./adapters/linkedin/constants.js";
import manifest from "./manifest.js";

/**
 * The Node fetch, for the upload of file bytes only: ctx.http sends a body
 * that is not a string as String(body). This request skips the host tracing
 * and audit log. The lookup is at call time, so a test can replace fetch.
 */
const nodeHttp: PluginHttpClient = { fetch: (url, init) => fetch(url, init) };

/**
 * The host hands the live PluginContext to setup() only; onApiRequest() is a
 * sibling lifecycle hook with no ctx argument, so setup() parks it here, with
 * the Page connections built on it, for the route handlers to use.
 */
let shared: { ctx: PluginContext; pages: PageConnections } | null = null;

/** The wire shape of a listed Page: snake_case, as when callers read table rows directly. */
function pageRow(page: PageSummary) {
  return {
    organization_id: page.organizationId,
    organization_urn: page.organizationUrn,
    page_name: page.name,
    vanity_name: page.vanityName,
    status: page.status,
  };
}

/**
 * The manifest declaration of an agent tool. The host shows agents the
 * manifest text only and never reads the declaration given to
 * ctx.tools.register, so the manifest is the one source.
 */
function declared(name: string) {
  const tool = manifest.tools?.find((t) => t.name === name);
  if (!tool) throw new Error(`Agent tool ${name} is not declared in the manifest`);
  return tool;
}

const plugin = definePlugin({
  async setup(ctx: PluginContext) {
    const pages = createPageConnections(ctx);
    shared = { ctx, pages };
    ctx.logger.info("LinkedIn Page plugin starting");
    const warning = versionWarning(new Date());
    if (warning) ctx.logger.warn(warning, { linkedInVersion: LINKEDIN_VERSION });

    ctx.tools.register(
      "linkedin-page-list",
      declared("linkedin-page-list"),
      async (_params, run) => {
        const listed = await pages.list(run.companyId);
        return {
          content: listed.length
            ? listed.map((p) => `${p.displayName} (${p.organizationId}) — ${p.status}`).join("\n")
            : "No LinkedIn Pages are connected for this company.",
          data: listed.map(pageRow),
        };
      },
    );

    ctx.tools.register(
      "linkedin-page-upload",
      declared("linkedin-page-upload"),
      async (params, run) => {
        const p = params as { attachmentId: string; organizationId?: string };
        try {
          const file = await ctx.issues.getAttachmentContent(p.attachmentId, run.companyId, {
            maxBytes: MAX_MEDIA_BYTES,
          });
          if (!file) {
            throw new Error(`Attachment ${p.attachmentId} was not found, or the plugin cannot read its issue.`);
          }
          const kind = mediaKindForContentType(file.contentType);
          if (!kind) throw new Error(`LinkedIn does not accept ${file.contentType}. Attach ${ACCEPTED_FILES}.`);
          const fileName = file.originalFilename ?? file.attachmentId;

          return await pages.actAs(run.companyId, p.organizationId, "upload", async (page) => {
            const mediaUrn = await uploadMedia(ctx.http, nodeHttp, {
              accessToken: page.accessToken,
              organizationId: page.organizationId,
              kind,
              contentType: file.contentType,
              bytes: Buffer.from(file.contentBase64, "base64"),
            });
            // If this read fails, the uploaded file stays unused at LinkedIn. A post
            // with the file needs the same read, so retrying the upload is the fix.
            const { status } = await mediaState(ctx.http, { accessToken: page.accessToken, mediaUrn, kind });
            await ctx.activity.log({
              companyId: run.companyId,
              message: `Uploaded ${fileName} for ${page.displayName}`,
              entityType: "linkedin_page_media",
              entityId: mediaUrn,
              metadata: {
                mediaUrn,
                attachmentId: file.attachmentId,
                sha256: file.sha256,
                contentType: file.contentType,
                byteSize: file.byteSize,
                organizationId: page.organizationId,
                agentId: run.agentId,
                runId: run.runId,
              },
            });
            return {
              content:
                `Uploaded ${fileName} for ${page.displayName} as ${mediaUrn} (${status}). ` +
                `Pass mediaUrn to linkedin-page-post${kind === "document" ? " with a title" : ""}.`,
              data: { mediaUrn, status, kind, originalFilename: file.originalFilename },
            };
          });
        } catch (err) {
          return { error: (err as Error).message };
        }
      },
    );

    ctx.tools.register(
      "linkedin-page-post",
      declared("linkedin-page-post"),
      async (params, run) => {
        const p = params as {
          text: string;
          organizationId?: string;
          visibility?: "PUBLIC" | "LOGGED_IN";
          mediaUrn?: string;
          title?: string;
          altText?: string;
        };
        try {
          const kind = p.mediaUrn ? mediaKindOfUrn(p.mediaUrn) : null;
          if (p.mediaUrn && !kind) {
            throw new Error(
              `${p.mediaUrn} is not an image or a document. Pass the mediaUrn that linkedin-page-upload returned.`,
            );
          }
          if (kind === "document" && !p.title) throw new Error("A post with a document needs a title.");
          const media: PostMedia | undefined = p.mediaUrn
            ? { id: p.mediaUrn, ...(p.title && { title: p.title }), ...(p.altText && { altText: p.altText }) }
            : undefined;

          return await pages.actAs(run.companyId, p.organizationId, "post", async (page) => {
            if (media && kind) {
              const state = await mediaState(ctx.http, { accessToken: page.accessToken, mediaUrn: media.id, kind });
              requirePostable(state, media.id, page.organizationUrn);
            }
            const result = await publishAsOrganization(ctx.http, {
              accessToken: page.accessToken,
              organizationId: page.organizationId,
              text: p.text,
              visibility: p.visibility,
              media,
            });
            await ctx.activity.log({
              companyId: run.companyId,
              message: `Posted as ${page.displayName}`,
              entityType: "linkedin_page_post",
              entityId: result.postUrn,
              metadata: {
                postUrn: result.postUrn,
                ...(media && { mediaUrn: media.id }),
                organizationId: page.organizationId,
                agentId: run.agentId,
                runId: run.runId,
              },
            });
            return {
              content: `Published as ${page.displayName}: ${result.permalink ?? result.postUrn}`,
              data: result,
            };
          });
        } catch (err) {
          return { error: (err as Error).message };
        }
      },
    );

    ctx.tools.register(
      "linkedin-page-react",
      declared("linkedin-page-react"),
      async (params, run) => {
        const p = params as { postUrn: string; organizationId?: string; reactionType?: ReactionType };
        try {
          return await pages.actAs(run.companyId, p.organizationId, "react", async (page) => {
            await reactAsOrganization(ctx.http, {
              accessToken: page.accessToken,
              organizationId: page.organizationId,
              postUrn: p.postUrn,
              reactionType: p.reactionType,
            });
            return { content: `Reacted to ${p.postUrn} as ${page.displayName}.` };
          });
        } catch (err) {
          return { error: (err as Error).message };
        }
      },
    );

    ctx.tools.register(
      "linkedin-page-comment",
      declared("linkedin-page-comment"),
      async (params, run) => {
        const p = params as { postUrn: string; text: string; organizationId?: string };
        try {
          return await pages.actAs(run.companyId, p.organizationId, "comment", async (page) => {
            await commentAsOrganization(ctx.http, {
              accessToken: page.accessToken,
              organizationId: page.organizationId,
              postUrn: p.postUrn,
              text: p.text,
            });
            return { content: `Commented on ${p.postUrn} as ${page.displayName}.` };
          });
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
  if (!shared) return { status: 503, body: { error: "Plugin worker is still starting" } };
  const { ctx, pages } = shared;

  const companyId = input.companyId;
  try {
    switch (input.routeKey) {
      case "list-pages": {
        const listed = await pages.list(companyId);
        return {
          status: 200,
          body: { pages: listed.map((p) => ({ ...pageRow(p), expires_at: p.expiresAt })) },
        };
      }

      case "oauth-start": {
        return { status: 200, body: await pages.startConnect(companyId, input.actor.actorId) };
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
          const connected = await pages.finishConnect(companyId, code, state, input.actor.actorId);
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
        const connected = await pages.finishConnect(companyId, body.code, body.state, input.actor.actorId);
        return { status: 200, body: { connected } };
      }

      case "disconnect": {
        const organizationId = input.params.organizationId;
        await pages.disconnect(companyId, organizationId);
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
 * Result for the browser redirect leg of OAuth.
 *
 * The host always sends `body` through res.json() and its response-header
 * allowlist covers only cache-control/etag/last-modified/x-request-id, so a
 * plugin route can return neither HTML nor a 302. The operator sees this JSON.
 */
function callbackResult(status: number, outcome: string, detail: string): PluginApiResponse {
  return { status, body: { outcome, detail } };
}
