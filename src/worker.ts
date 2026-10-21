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
  type ConnectOutcome,
  type LinkedInRedirect,
  type PageConnections,
  type PageSummary,
} from "./page-connections.js";
import type { FileTransport, ReactionType } from "./adapters/linkedin/page.js";
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

/** The facts of an activity entry that only the action knows. */
interface ActivityFacts {
  message: string;
  entityType: string;
  entityId: string;
  /** The metadata of this action. The tool shell adds organizationId, agentId and runId. */
  metadata: Record<string, unknown>;
}

/** What one action as a Page gives back: the tool result and the facts of its activity entry. */
interface ActionDone {
  result: ToolResult;
  activity: ActivityFacts;
}

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

/**
 * Build the plugin. `fileTransport` sends the file bytes of an upload; the
 * tests pass a fake. The host loads the default export, which uses the Node fetch.
 */
export function createPlugin(fileTransport?: FileTransport) {
  return definePlugin({
    async setup(ctx: PluginContext) {
      const pages = createPageConnections(ctx, fileTransport);
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
       * Write the activity entry of an action that is done. The action is live
       * on LinkedIn, so a failed write goes to the plugin log and not to the
       * agent: a tool error can make the agent do the action again.
       */
      async function writeActivityEntry(tool: ToolName, run: ToolRunContext, organizationId: string, facts: ActivityFacts) {
        const { message, entityType, entityId, metadata } = facts;
        const entryMetadata = { ...metadata, organizationId, agentId: run.agentId, runId: run.runId };
        try {
          await ctx.activity.log({ companyId: run.companyId, message, entityType, entityId, metadata: entryMetadata });
        } catch (err) {
          ctx.logger.error("Could not write the activity entry of a done action", {
            tool,
            companyId: run.companyId,
            entityType,
            entityId,
            metadata: entryMetadata,
            error: (err as Error).message,
          });
        }
      }

      /**
       * Register the agent tool `linkedin-page-{action}`. Each call does `action`
       * as the Page that its organizationId names, and a failure becomes the
       * tool error. A done action gets one activity entry from the facts that
       * `work` gives back. The parameter type comes from the manifest schema of
       * the tool.
       */
      function pageTool<A extends PageToolAction>(
        action: A,
        work: (page: ActingPage, params: ToolParams<`linkedin-page-${A}`>, run: ToolRunContext) => Promise<ActionDone>,
      ): void {
        const name = `linkedin-page-${action}` as const;
        ctx.tools.register(name, declared(name), async (params, run) => {
          // The host passes the parameters untyped. The manifest schema states their shape.
          const p = params as ToolParams<`linkedin-page-${A}`> & { organizationId?: string };
          let done: ActionDone & { organizationId: string };
          try {
            done = await pages.actAs(run.companyId, p.organizationId, action, async (page) => ({
              ...(await work(page, p, run)),
              organizationId: page.organizationId,
            }));
          } catch (err) {
            return { error: (err as Error).message };
          }
          await writeActivityEntry(name, run, done.organizationId, done.activity);
          return done.result;
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
        return {
          result: {
            content:
              `Uploaded ${fileName} for ${page.displayName} as ${mediaUrn} (${status}). ` +
              `Pass mediaUrn to linkedin-page-post${kind === "document" ? " with a title" : ""}.`,
            data: { mediaUrn, status, kind, originalFilename: file.originalFilename },
          },
          activity: {
            message: `Uploaded ${fileName} for ${page.displayName}`,
            entityType: "linkedin_page_media",
            entityId: mediaUrn,
            metadata: {
              mediaUrn,
              attachmentId: file.attachmentId,
              sha256: file.sha256,
              contentType: file.contentType,
              byteSize: file.byteSize,
            },
          },
        };
      });

      pageTool("post", async (page, p) => {
        const published = await page.post({
          text: p.text,
          visibility: p.visibility,
          media: p.mediaUrn ? { mediaUrn: p.mediaUrn, title: p.title, altText: p.altText } : undefined,
        });
        return {
          result: {
            content: `Published as ${page.displayName}: ${published.permalink ?? published.postUrn}`,
            data: published,
          },
          activity: {
            message: `Posted as ${page.displayName}`,
            entityType: "linkedin_page_post",
            entityId: published.postUrn,
            metadata: { postUrn: published.postUrn, ...(p.mediaUrn && { mediaUrn: p.mediaUrn }) },
          },
        };
      });

      // Read-only: no activity entry, since nothing changed on LinkedIn.
      ctx.tools.register("linkedin-page-stats", declared("linkedin-page-stats"), async (params, run) => {
        const p = params as ToolParams<"linkedin-page-stats">;
        try {
          return await pages.actAs(run.companyId, p.organizationId, "stats", async (page) => {
            const rows = await page.stats({ postUrns: p.postUrns, count: p.count });
            const content = rows.length
              ? [
                  `Post statistics for ${page.displayName} (organic, lifetime):`,
                  ...rows.map(
                    (r) =>
                      `${r.postUrn}${r.createdAt ? ` (${r.createdAt.slice(0, 10)})` : ""}: ` +
                      `${r.impressionCount} impressions, ${r.clickCount} clicks, ${r.likeCount} likes, ` +
                      `${r.commentCount} comments, ${r.shareCount} reposts, ` +
                      `engagement ${(r.engagement * 100).toFixed(2)}%`,
                  ),
                ].join("\n")
              : `${page.displayName} has no posts to report.`;
            return { content, data: { organizationId: page.organizationId, posts: rows } };
          });
        } catch (err) {
          return { error: (err as Error).message };
        }
      });

      pageTool("react", async (page, p) => {
        const { reactionUrn, reactionType } = await page.react(p.postUrn, p.reactionType);
        return {
          result: { content: `Reacted to ${p.postUrn} as ${page.displayName}.` },
          activity: {
            message: `Reacted to ${p.postUrn} as ${page.displayName}`,
            entityType: "linkedin_page_reaction",
            // A reaction that exists already comes back without a URN.
            entityId: reactionUrn ?? p.postUrn,
            metadata: { postUrn: p.postUrn, reactionType, ...(reactionUrn && { reactionUrn }) },
          },
        };
      });

      pageTool("comment", async (page, p) => {
        const { commentUrn } = await page.comment(p.postUrn, p.text);
        return {
          result: { content: `Commented on ${p.postUrn} as ${page.displayName}.` },
          activity: {
            message: `Commented on ${p.postUrn} as ${page.displayName}`,
            entityType: "linkedin_page_comment",
            entityId: commentUrn ?? p.postUrn,
            metadata: { postUrn: p.postUrn, ...(commentUrn && { commentUrn }) },
          },
        };
      });
    },

    async onApiRequest(input: PluginApiRequestInput): Promise<PluginApiResponse> {
      return handleApiRequest(input);
    },
  });
}

const plugin = createPlugin();

export default plugin;

// The host resolves auth, company access and capabilities before calling us,
// so these handlers only deal with plugin-specific validation.

type RouteHandler = (input: PluginApiRequestInput, shared: Shared) => Promise<PluginApiResponse>;

/**
 * The status of each connect outcome, and the title that oauth-callback shows.
 * Both finish routes use this table, so one outcome has one status. 400: the
 * operator can remove the cause and connect again. 502: LinkedIn failed. 500:
 * the plugin failed. The connect outcome table of README.md shows each status.
 */
export const CONNECT_RESULTS: Record<ConnectOutcome["kind"], { status: number; title: string }> = {
  connected: { status: 200, title: "LinkedIn Page connected" },
  declined: { status: 400, title: "LinkedIn authorization was declined" },
  incomplete_redirect: { status: 400, title: "Missing code or state" },
  invalid_state: { status: 400, title: "Could not connect the Page" },
  code_refused: { status: 400, title: "Could not connect the Page" },
  grant_refused: { status: 400, title: "Could not connect the Page" },
  no_page: { status: 400, title: "Could not connect the Page" },
  linkedin_failed: { status: 502, title: "Could not connect the Page" },
  plugin_failed: { status: 500, title: "Could not connect the Page" },
};

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
    const outcome = await pages.finishConnect(companyId, query, actor.actorId);
    const { status, title } = CONNECT_RESULTS[outcome.kind];
    return callbackResult(
      status,
      title,
      outcome.kind === "connected"
        ? `Connected: ${outcome.pages.map((p) => p.name ?? p.organizationUrn).join(", ")}. You can close this tab.`
        : outcome.reason,
    );
  },

  async "oauth-complete"({ companyId, actor, body }, { pages }) {
    const outcome = await pages.finishConnect(companyId, (body ?? {}) as LinkedInRedirect, actor.actorId);
    return {
      status: CONNECT_RESULTS[outcome.kind].status,
      body:
        outcome.kind === "connected"
          ? { connected: outcome.pages }
          : { error: outcome.reason, kind: outcome.kind },
    };
  },

  async disconnect({ companyId, params }, { pages }) {
    const organizationRef = params.organizationId;
    if (!(await pages.disconnect(companyId, organizationRef))) {
      return { status: 404, body: { error: `The company has no Page connection for Page ${organizationRef}.` } };
    }
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
