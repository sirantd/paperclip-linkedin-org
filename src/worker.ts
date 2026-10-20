import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import type {
  PluginContext,
  PluginApiRequestInput,
  PluginApiResponse,
  ToolResult,
  ToolRunContext,
} from "@paperclipai/plugin-sdk";
import {
  createPageConnections,
  type ActingPage,
  type PageConnections,
  type PageSummary,
} from "./page-connections.js";
import type { ReactionType } from "./adapters/linkedin/page.js";
import type { PageAction } from "./adapters/linkedin/scopes.js";
import { MAX_MEDIA_BYTES } from "./adapters/linkedin/media.js";
import { LINKEDIN_VERSION, versionWarning } from "./adapters/linkedin/constants.js";
import manifest, { type RouteKey, type ToolName, type ToolParams } from "./manifest.js";

/** What the route handlers use: the live PluginContext and the Page connections built on it. */
interface Shared {
  ctx: PluginContext;
  pages: PageConnections;
}

/**
 * The host hands the live PluginContext to setup() only; onApiRequest() is a
 * sibling lifecycle hook with no ctx argument, so setup() parks it here, with
 * the Page connections built on it, for the route handlers to use.
 */
let shared: Shared | null = null;

/** The action of the agent tool `N`, if `N` is `linkedin-page-{action}`. */
type ActionOf<N> = N extends `linkedin-page-${infer A}` ? A : never;

/** Each Page action that has an agent tool in the manifest. */
type PageToolAction = Extract<PageAction, ActionOf<ToolName>>;

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;

/** The manifest enum of reactionType must name the same reactions as ReactionType. */
type ReactionTypesMatch = Assert<Equal<ToolParams<"linkedin-page-react">["reactionType"], ReactionType | undefined>>;

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
function declared(name: ToolName) {
  const tool = manifest.tools.find((t) => t.name === name);
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

    /**
     * Register the agent tool `linkedin-page-{action}`. Each call does `action`
     * as the Page that its organizationId names, and a failure becomes the
     * tool error. The parameter type comes from the manifest schema of the tool.
     */
    function pageTool<A extends PageToolAction>(
      action: A,
      work: (page: ActingPage, params: ToolParams<`linkedin-page-${A}`>, run: ToolRunContext) => Promise<ToolResult>,
    ): void {
      const name = `linkedin-page-${action}` as const;
      ctx.tools.register(name, declared(name), async (params, run) => {
        // The host passes the parameters untyped. The manifest schema states their shape.
        const p = params as ToolParams<`linkedin-page-${A}`> & { organizationId?: string };
        try {
          return await pages.actAs(run.companyId, p.organizationId, action, (page) => work(page, p, run));
        } catch (err) {
          return { error: (err as Error).message };
        }
      });
    }

    pageTool("upload", async (page, p, run) => {
      const file = await ctx.issues.getAttachmentContent(p.attachmentId, run.companyId, {
        maxBytes: MAX_MEDIA_BYTES,
      });
      if (!file) {
        throw new Error(`Attachment ${p.attachmentId} was not found, or the plugin cannot read its issue.`);
      }
      const fileName = file.originalFilename ?? file.attachmentId;
      const { mediaUrn, status, kind } = await page.upload({
        contentType: file.contentType,
        bytes: Buffer.from(file.contentBase64, "base64"),
      });
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

    pageTool("post", async (page, p, run) => {
      const result = await page.post({
        text: p.text,
        visibility: p.visibility,
        media: p.mediaUrn ? { mediaUrn: p.mediaUrn, title: p.title, altText: p.altText } : undefined,
      });
      await ctx.activity.log({
        companyId: run.companyId,
        message: `Posted as ${page.displayName}`,
        entityType: "linkedin_page_post",
        entityId: result.postUrn,
        metadata: {
          postUrn: result.postUrn,
          ...(p.mediaUrn && { mediaUrn: p.mediaUrn }),
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

    pageTool("react", async (page, p) => {
      await page.react(p.postUrn, p.reactionType);
      return { content: `Reacted to ${p.postUrn} as ${page.displayName}.` };
    });

    pageTool("comment", async (page, p) => {
      await page.comment(p.postUrn, p.text);
      return { content: `Commented on ${p.postUrn} as ${page.displayName}.` };
    });
  },

  async onApiRequest(input: PluginApiRequestInput): Promise<PluginApiResponse> {
    return handleApiRequest(input);
  },
});

export default plugin;

// The host resolves auth, company access and capabilities before calling us,
// so these handlers only deal with plugin-specific validation.

type RouteHandler = (input: PluginApiRequestInput, shared: Shared) => Promise<PluginApiResponse>;

/** One handler for each manifest route. A manifest route without a handler fails the type check. */
const routes: Record<RouteKey, RouteHandler> = {
  async "list-pages"({ companyId }, { pages }) {
    const listed = await pages.list(companyId);
    return {
      status: 200,
      body: { pages: listed.map((p) => ({ ...pageRow(p), expires_at: p.expiresAt })) },
    };
  },

  async "oauth-start"({ companyId, actor }, { pages }) {
    return { status: 200, body: await pages.startConnect(companyId, actor.actorId) };
  },

  async "oauth-callback"({ companyId, actor, query }, { pages }) {
    const code = String(query.code ?? "");
    const state = String(query.state ?? "");
    const oauthError = query.error ? String(query.error) : null;
    if (oauthError) {
      return callbackResult(400,
        "LinkedIn authorization was declined",
        `${oauthError}: ${String(query.error_description ?? "")}`,
      );
    }
    if (!code || !state) {
      return callbackResult(400, "Missing code or state", "LinkedIn did not return an authorization code.");
    }
    try {
      const connected = await pages.finishConnect(companyId, code, state, actor.actorId);
      return callbackResult(200,
        "LinkedIn Page connected",
        `Connected: ${connected.map((p) => p.name ?? p.organizationUrn).join(", ")}. You can close this tab.`,
      );
    } catch (err) {
      return callbackResult(400, "Could not connect the Page", (err as Error).message);
    }
  },

  async "oauth-complete"({ companyId, actor, body }, { pages }) {
    const { code, state } = (body ?? {}) as { code?: string; state?: string };
    if (!code || !state) {
      return { status: 400, body: { error: "code and state are required" } };
    }
    const connected = await pages.finishConnect(companyId, code, state, actor.actorId);
    return { status: 200, body: { connected } };
  },

  async disconnect({ companyId, params }, { pages }) {
    const organizationRef = params.organizationId;
    await pages.disconnect(companyId, organizationRef);
    return { status: 200, body: { disconnected: organizationRef } };
  },
};

function isRouteKey(key: string): key is RouteKey {
  return Object.hasOwn(routes, key);
}

async function handleApiRequest(input: PluginApiRequestInput): Promise<PluginApiResponse> {
  if (!shared) return { status: 503, body: { error: "Plugin worker is still starting" } };
  if (!isRouteKey(input.routeKey)) {
    return { status: 404, body: { error: `Unknown route ${input.routeKey}` } };
  }

  try {
    return await routes[input.routeKey](input, shared);
  } catch (err) {
    shared.ctx.logger.error("LinkedIn Page API request failed", {
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

// definePlugin only wraps the definition. runWorker starts the stdio JSON-RPC
// loop the host speaks; without it the worker process evaluates and exits 0.
// It comes last, so the route table exists before the first request.
runWorker(plugin, import.meta.url);
