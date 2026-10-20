import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginApiRequestInput } from "@paperclipai/plugin-sdk";
import { createPlugin } from "../src/worker.js";
import manifest from "../src/manifest.js";
import { REQUESTED_SCOPES } from "../src/adapters/linkedin/scopes.js";
import { LINKEDIN_VERSION } from "../src/adapters/linkedin/constants.js";
import { MAX_MEDIA_BYTES } from "../src/adapters/linkedin/media.js";
import {
  ACME,
  COMMENTS_URL,
  DOCUMENTS_URL,
  GLOBEX,
  ORG_ACLS_URL,
  POSTS_URL,
  REACTIONS_URL,
  TOKEN_URL,
  UPLOAD_URL,
  json,
  routeInput,
  wire,
  createWorld,
  seedAttachment,
  type FakePage,
  type World,
} from "./world.js";

const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const PDF = new Uint8Array([37, 80, 68, 70, 45, 49, 46, 55]);

// Smoke tests for the agent tools and API routes: wiring, wire shapes and
// the answers the worker builds. Page connection behavior is covered in
// page-connections.test.ts, and the LinkedIn calls of a Page, media rules
// included, in linkedin-page.test.ts.

let world: World;
let plugin: ReturnType<typeof createPlugin>;

beforeEach(async () => {
  world = await createWorld();
  // The file bytes of an upload go to the LinkedIn fake.
  plugin = createPlugin(world.linkedin.fetch);
  await plugin.definition.setup(world.ctx);
});

afterEach(() => world.close());

function route(
  routeKey: string,
  input: Partial<Pick<PluginApiRequestInput, "query" | "body" | "params">> = {},
  companyId = world.companyId,
) {
  return plugin.definition.onApiRequest!(routeInput(routeKey, companyId, input));
}

const RUN_ID = "run-1";

function tool(name: string, params: Record<string, unknown> = {}, companyId = world.companyId) {
  return world.harness.executeTool(name, params, { companyId, runId: RUN_ID });
}

async function startConnect(): Promise<string> {
  const res = await route("oauth-start", { body: { companyId: world.companyId } });
  const { authorizationUrl } = res.body as { authorizationUrl: string };
  return new URL(authorizationUrl).searchParams.get("state")!;
}

async function connect(pages: FakePage[]) {
  world.linkedin.scriptConnect(pages);
  const state = await startConnect();
  return route("oauth-complete", { body: { code: "code-1", state } });
}

async function listPages() {
  const res = await route("list-pages", { query: { companyId: world.companyId } });
  return (wire(res.body) as { pages: Array<Record<string, unknown>> }).pages;
}

describe("setup", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** The log entries of one setup() at `months` calendar months after LINKEDIN_VERSION. */
  async function setupLogsAt(months: number) {
    const year = Number(LINKEDIN_VERSION.slice(0, 4));
    const month = Number(LINKEDIN_VERSION.slice(4, 6));
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(Date.UTC(year, month - 1 + months, 15)));
    const before = world.harness.logs.length;
    await plugin.definition.setup(world.ctx);
    return world.harness.logs.slice(before);
  }

  it("does not warn while LINKEDIN_VERSION is younger than 11 months", async () => {
    expect((await setupLogsAt(10)).filter((log) => log.level === "warn")).toEqual([]);
  });

  it("warns from 11 months after LINKEDIN_VERSION", async () => {
    expect(await setupLogsAt(11)).toContainEqual({
      level: "warn",
      message:
        `LinkedIn API version ${LINKEDIN_VERSION} is 11 months old. LinkedIn retires a version ` +
        "after one year at the earliest. Update LINKEDIN_VERSION and release the plugin.",
      meta: { linkedInVersion: LINKEDIN_VERSION },
    });
  });
});

describe("agent tools", () => {
  it("registers each manifest tool with its manifest declaration", async () => {
    const register = vi.spyOn(world.ctx.tools, "register");
    await plugin.definition.setup(world.ctx);

    const declarations = manifest.tools ?? [];
    expect(register.mock.calls.map(([name]) => name).sort()).toEqual(
      declarations.map((t) => t.name).sort(),
    );
    for (const [name, declaration] of register.mock.calls) {
      expect(declaration).toBe(declarations.find((t) => t.name === name));
    }
  });

  it.each([
    ["linkedin-page-post", "post", "w_organization_social", { text: "Hi" }],
    ["linkedin-page-upload", "upload", "w_organization_social", { attachmentId: "attachment-1" }],
    ["linkedin-page-react", "react", "w_organization_social, w_organization_social_feed", { postUrn: "urn:li:share:1" }],
    [
      "linkedin-page-comment",
      "comment",
      "w_organization_social, w_organization_social_feed",
      { postUrn: "urn:li:share:1", text: "Nice" },
    ],
  ] as const)("%s checks the scopes of %s before any other step", async (name, action, missing, params) => {
    await connect([ACME]);
    await world.sql(`update ${world.ctx.db.namespace}.page_connections set scopes = '{rw_organization_admin}'`);
    const before = world.linkedin.requests.length;

    expect(await tool(name, params)).toEqual({
      error: `Page 111 was connected without ${missing}, which ${action} needs. Reconnect the Page in Settings.`,
    });
    expect(world.linkedin.requests).toHaveLength(before);
  });
});

describe("activity entries", () => {
  /** The metadata that the tool shell adds to each entry. */
  const COMMON = { organizationId: "111", agentId: "agent-test", runId: RUN_ID };

  /** One tool call: the LinkedIn answers it needs, its parameters and the activity entry it must write. */
  type Case = () => { params: Record<string, unknown>; entry: Record<string, unknown> };

  it.each<[string, string, Case]>([
    ["linkedin-page-post", "a post", () => {
      world.linkedin.scriptActions("urn:li:share:9");
      return {
        params: { text: "Hello" },
        entry: {
          message: "Posted as Acme",
          entityType: "linkedin_page_post",
          entityId: "urn:li:share:9",
          metadata: { postUrn: "urn:li:share:9", ...COMMON },
        },
      };
    }],
    ["linkedin-page-post", "a post with an image", () => {
      world.linkedin.scriptMedia();
      world.linkedin.scriptActions("urn:li:share:9");
      return {
        params: { text: "Q3", mediaUrn: "urn:li:image:1" },
        entry: {
          message: "Posted as Acme",
          entityType: "linkedin_page_post",
          entityId: "urn:li:share:9",
          metadata: { postUrn: "urn:li:share:9", mediaUrn: "urn:li:image:1", ...COMMON },
        },
      };
    }],
    ["linkedin-page-upload", "an upload", () => {
      world.linkedin.scriptMedia();
      const file = seedAttachment(world, { contentType: "image/png", bytes: PNG, originalFilename: "chart.png" });
      return {
        params: { attachmentId: file.id },
        entry: {
          message: "Uploaded chart.png for Acme",
          entityType: "linkedin_page_media",
          entityId: "urn:li:image:1",
          metadata: {
            mediaUrn: "urn:li:image:1",
            attachmentId: file.id,
            sha256: file.sha256,
            contentType: "image/png",
            byteSize: PNG.byteLength,
            ...COMMON,
          },
        },
      };
    }],
    ["linkedin-page-react", "a reaction", () => {
      world.linkedin.scriptActions();
      return {
        params: { postUrn: "urn:li:share:1", reactionType: "PRAISE" },
        entry: {
          message: "Reacted to urn:li:share:1 as Acme",
          entityType: "linkedin_page_reaction",
          entityId: "urn:li:reaction:(urn:li:organization:111,urn:li:share:1)",
          metadata: {
            postUrn: "urn:li:share:1",
            reactionType: "PRAISE",
            reactionUrn: "urn:li:reaction:(urn:li:organization:111,urn:li:share:1)",
            ...COMMON,
          },
        },
      };
    }],
    ["linkedin-page-react", "a reaction that exists already", () => {
      world.linkedin.on("POST", REACTIONS_URL, () => json({ code: "DUPLICATE_REACTION" }, 409));
      return {
        params: { postUrn: "urn:li:share:1" },
        entry: {
          message: "Reacted to urn:li:share:1 as Acme",
          entityType: "linkedin_page_reaction",
          entityId: "urn:li:share:1",
          metadata: { postUrn: "urn:li:share:1", reactionType: "LIKE", ...COMMON },
        },
      };
    }],
    ["linkedin-page-comment", "a comment", () => {
      world.linkedin.scriptActions();
      return {
        params: { postUrn: "urn:li:share:1", text: "Nice" },
        entry: {
          message: "Commented on urn:li:share:1 as Acme",
          entityType: "linkedin_page_comment",
          entityId: "urn:li:comment:(urn:li:share:1,1)",
          metadata: { postUrn: "urn:li:share:1", commentUrn: "urn:li:comment:(urn:li:share:1,1)", ...COMMON },
        },
      };
    }],
  ])("%s writes one activity entry for %s", async (name, _label, prepare) => {
    await connect([ACME]);
    const { params, entry } = prepare();

    expect(await tool(name, params)).not.toHaveProperty("error");
    expect(world.harness.activity).toEqual([{ companyId: world.companyId, ...entry }]);
  });

  it("returns the result of a done post when the activity entry fails, and logs the failure", async () => {
    await connect([ACME]);
    world.linkedin.scriptActions("urn:li:share:9");
    vi.spyOn(world.ctx.activity, "log").mockRejectedValueOnce(new Error("activity log is down"));

    expect(await tool("linkedin-page-post", { text: "Hello" })).toEqual({
      content: "Published as Acme: https://www.linkedin.com/feed/update/urn:li:share:9/",
      data: { postUrn: "urn:li:share:9", permalink: "https://www.linkedin.com/feed/update/urn:li:share:9/" },
    });
    expect(world.linkedin.requestsTo(POSTS_URL)).toHaveLength(1);
    expect(world.harness.logs).toContainEqual({
      level: "error",
      message: "Could not write the activity entry of a done action",
      meta: {
        tool: "linkedin-page-post",
        companyId: world.companyId,
        entityType: "linkedin_page_post",
        entityId: "urn:li:share:9",
        metadata: { postUrn: "urn:li:share:9", ...COMMON },
        error: "activity log is down",
      },
    });
  });
});

describe("linkedin-page-post", () => {
  it("posts as the acting Page", async () => {
    await connect([ACME]);
    world.linkedin.scriptActions("urn:li:share:9");

    const result = await tool("linkedin-page-post", { text: "Hello" });

    expect(result).toEqual({
      content: "Published as Acme: https://www.linkedin.com/feed/update/urn:li:share:9/",
      data: { postUrn: "urn:li:share:9", permalink: "https://www.linkedin.com/feed/update/urn:li:share:9/" },
    });
    const [post] = world.linkedin.requestsTo(POSTS_URL);
    expect(post!.headers.Authorization).toBe("Bearer access-1");
    expect(JSON.parse(post!.body)).toMatchObject({
      author: "urn:li:organization:111",
      commentary: "Hello",
      visibility: "PUBLIC",
    });
  });

  it("returns a failure as a tool error", async () => {
    await connect([ACME, GLOBEX]);
    expect(await tool("linkedin-page-post", { text: "Hi" })).toEqual({
      error:
        "Multiple LinkedIn Pages are connected. Pass organizationId explicitly, " +
        "or set a default Page in the plugin settings.",
    });
    expect(world.linkedin.requestsTo(POSTS_URL)).toHaveLength(0);
  });

  it("expires the Page connection when LinkedIn rejects the token", async () => {
    await connect([ACME]);
    world.linkedin.on("POST", POSTS_URL, () => json({ code: "REVOKED_ACCESS_TOKEN" }, 401));

    expect(await tool("linkedin-page-post", { text: "Hi" })).toEqual({
      error:
        'LinkedIn rejected the token for Page 111 (LinkedIn publish 401: {"code":"REVOKED_ACCESS_TOKEN"}). ' +
        "Reconnect the Page in Settings.",
    });
    expect(await listPages()).toEqual([expect.objectContaining({ organization_id: "111", status: "expired" })]);
    expect(world.harness.activity).toEqual([]);
  });

  it("names the developer action when LinkedIn retired the API version", async () => {
    await connect([ACME]);
    world.linkedin.on("POST", POSTS_URL, () => json({ code: "NONEXISTENT_VERSION" }, 426));

    expect(await tool("linkedin-page-post", { text: "Hi" })).toEqual({
      error:
        `LinkedIn retired API version ${LINKEDIN_VERSION} (LinkedIn publish 426: {"code":"NONEXISTENT_VERSION"}). ` +
        "Update LINKEDIN_VERSION and release the plugin. A reconnect does not help.",
    });
    expect(await listPages()).toEqual([expect.objectContaining({ organization_id: "111", status: "active" })]);
  });

  it("posts an uploaded image with its alternative text", async () => {
    await connect([ACME]);
    world.linkedin.scriptMedia();
    world.linkedin.scriptActions("urn:li:share:9");

    const result = await tool("linkedin-page-post", { text: "Q3", mediaUrn: "urn:li:image:1", altText: "A chart" });

    expect(result).toHaveProperty("content", "Published as Acme: https://www.linkedin.com/feed/update/urn:li:share:9/");
    const [post] = world.linkedin.requestsTo(POSTS_URL);
    expect(JSON.parse(post!.body)).toMatchObject({
      commentary: "Q3",
      content: { media: { id: "urn:li:image:1", altText: "A chart" } },
    });
  });

  it("posts an uploaded document with its title", async () => {
    await connect([ACME]);
    world.linkedin.scriptMedia();
    world.linkedin.scriptActions();

    await tool("linkedin-page-post", { text: "Report", mediaUrn: "urn:li:document:1", title: "Q3 report" });

    const [post] = world.linkedin.requestsTo(POSTS_URL);
    expect(JSON.parse(post!.body).content).toEqual({ media: { id: "urn:li:document:1", title: "Q3 report" } });
  });

  it("publishes nothing while LinkedIn processes the file", async () => {
    await connect([ACME]);
    world.linkedin.scriptMedia("PROCESSING");
    world.linkedin.scriptActions();

    expect(await tool("linkedin-page-post", { text: "Q3", mediaUrn: "urn:li:image:1" })).toEqual({
      error: "LinkedIn is still processing urn:li:image:1 (PROCESSING). Call linkedin-page-post again later.",
    });
    expect(world.linkedin.requestsTo(POSTS_URL)).toHaveLength(0);
  });
});

describe("linkedin-page-upload", () => {
  it("uploads an image as the acting Page", async () => {
    await connect([ACME]);
    world.linkedin.scriptMedia("PROCESSING");
    const file = seedAttachment(world, { contentType: "image/png", bytes: PNG, originalFilename: "chart.png" });

    const result = await tool("linkedin-page-upload", { attachmentId: file.id });

    expect(result).toEqual({
      content: "Uploaded chart.png for Acme as urn:li:image:1 (PROCESSING). Pass mediaUrn to linkedin-page-post.",
      data: { mediaUrn: "urn:li:image:1", status: "PROCESSING", kind: "image", originalFilename: "chart.png" },
    });
    const [put] = world.linkedin.requestsTo(UPLOAD_URL);
    expect(put!.headers).toMatchObject({ Authorization: "Bearer access-1", "Content-Type": "image/png" });
    expect(put!.bytes).toEqual(PNG);
  });

  it("tells the agent that a post with an uploaded document needs a title", async () => {
    await connect([ACME]);
    world.linkedin.scriptMedia();
    const file = seedAttachment(world, { contentType: "application/pdf", bytes: PDF, originalFilename: "q3.pdf" });

    const result = await tool("linkedin-page-upload", { attachmentId: file.id });

    expect(result).toHaveProperty(
      "content",
      "Uploaded q3.pdf for Acme as urn:li:document:1 (AVAILABLE). Pass mediaUrn to linkedin-page-post with a title.",
    );
  });

  it("refuses an attachment that it cannot read", async () => {
    await connect([ACME]);
    const file = seedAttachment(world, { contentType: "image/png", bytes: PNG }, await world.addCompany());

    expect(await tool("linkedin-page-upload", { attachmentId: file.id })).toEqual({
      error: `Attachment ${file.id} was not found, or the plugin cannot read its issue.`,
    });
  });

  it("refuses a file over 10 MiB", async () => {
    await connect([ACME]);
    const file = seedAttachment(world, { contentType: "application/pdf", bytes: PDF, byteSize: MAX_MEDIA_BYTES + 1 });

    // The host writes this error text; the test pins only the cap.
    expect(await tool("linkedin-page-upload", { attachmentId: file.id })).toEqual({
      error: expect.stringMatching(new RegExp(`over the ${MAX_MEDIA_BYTES}-byte cap$`)),
    });
    expect(world.linkedin.requestsTo(DOCUMENTS_URL)).toHaveLength(0);
  });

  it("expires the Page connection when LinkedIn rejects the token at the upload", async () => {
    await connect([ACME]);
    world.linkedin.scriptMedia();
    world.linkedin.on("PUT", UPLOAD_URL, () => json({ code: "REVOKED_ACCESS_TOKEN" }, 401));
    const file = seedAttachment(world, { contentType: "image/png", bytes: PNG });

    expect(await tool("linkedin-page-upload", { attachmentId: file.id })).toEqual({
      error:
        'LinkedIn rejected the token for Page 111 (LinkedIn image upload 401: {"code":"REVOKED_ACCESS_TOKEN"}). ' +
        "Reconnect the Page in Settings.",
    });
    expect(await listPages()).toEqual([expect.objectContaining({ organization_id: "111", status: "expired" })]);
  });
});

describe("linkedin-page-react", () => {
  it("reacts as the acting Page", async () => {
    await connect([ACME]);
    world.linkedin.scriptActions();

    const result = await tool("linkedin-page-react", { postUrn: "urn:li:share:1", reactionType: "PRAISE" });

    expect(result).toEqual({ content: "Reacted to urn:li:share:1 as Acme." });
    const [req] = world.linkedin.requestsTo(REACTIONS_URL);
    expect(JSON.parse(req!.body)).toEqual({ root: "urn:li:share:1", reactionType: "PRAISE" });
  });

  it("names the action and the Page when LinkedIn refuses the reaction", async () => {
    await connect([ACME]);
    world.linkedin.on("POST", REACTIONS_URL, () => json({ code: "ACCESS_DENIED" }, 403));

    const result = await tool("linkedin-page-react", { postUrn: "urn:li:share:1" });

    expect(result).toEqual({
      error: expect.stringMatching(/^LinkedIn refused react as Page 111 \(LinkedIn react 403: \{"code":"ACCESS_DENIED"\}\)\. /),
    });
    expect(await listPages()).toEqual([expect.objectContaining({ organization_id: "111", status: "active" })]);
  });
});

describe("linkedin-page-comment", () => {
  it("comments as the acting Page", async () => {
    await connect([ACME]);
    world.linkedin.scriptActions();

    const result = await tool("linkedin-page-comment", { postUrn: "urn:li:share:1", text: "Nice" });

    expect(result).toEqual({ content: "Commented on urn:li:share:1 as Acme." });
    const [req] = world.linkedin.requestsTo(COMMENTS_URL);
    expect(JSON.parse(req!.body)).toMatchObject({ object: "urn:li:share:1", message: { text: "Nice" } });
  });
});

describe("linkedin-page-list", () => {
  it("lists the Pages as text and snake_case rows", async () => {
    await connect([GLOBEX, { id: "333", name: null }, ACME]);

    const result = wire(await tool("linkedin-page-list"));

    expect(result).toEqual({
      content: [
        "Acme (111) — active",
        "Globex (222) — active",
        "urn:li:organization:333 (333) — active",
      ].join("\n"),
      data: [
        { organization_id: "111", organization_urn: "urn:li:organization:111", page_name: "Acme", vanity_name: "acme", status: "active" },
        { organization_id: "222", organization_urn: "urn:li:organization:222", page_name: "Globex", vanity_name: "globex", status: "active" },
        { organization_id: "333", organization_urn: "urn:li:organization:333", page_name: null, vanity_name: null, status: "active" },
      ],
    });
  });

  it("says so when no Page is connected", async () => {
    expect(await tool("linkedin-page-list")).toEqual({
      content: "No LinkedIn Pages are connected for this company.",
      data: [],
    });
  });
});

describe("oauth-start route", () => {
  it("returns the authorization URL and the requested scopes", async () => {
    expect(await route("oauth-start", { body: { companyId: world.companyId } })).toEqual({
      status: 200,
      body: {
        authorizationUrl: expect.stringMatching(/^https:\/\/www\.linkedin\.com\/oauth\/v2\/authorization\?/),
        scopes: [...REQUESTED_SCOPES],
      },
    });
  });

  it("answers 500 with the error text", async () => {
    const other = await world.addCompany();
    expect(await route("oauth-start", {}, other)).toEqual({
      status: 500,
      body: { error: "LinkedIn Page plugin is not configured for this company" },
    });
  });

  it("answers 500 with text that names dekRef for a DEK that cannot seal tokens", async () => {
    world.secrets.dek = Buffer.alloc(16).toString("base64");
    expect(await route("oauth-start", { body: { companyId: world.companyId } })).toEqual({
      status: 500,
      body: { error: expect.stringMatching(/^The Token Encryption Key \(dekRef\) cannot seal tokens: /) },
    });
  });
});

describe("oauth-complete route", () => {
  it("returns the connected Pages, which list-pages then shows", async () => {
    expect(await connect([ACME, GLOBEX])).toEqual({
      status: 200,
      body: {
        connected: [
          { organizationUrn: "urn:li:organization:111", organizationId: "111", name: "Acme", vanityName: "acme" },
          { organizationUrn: "urn:li:organization:222", organizationId: "222", name: "Globex", vanityName: "globex" },
        ],
      },
    });
    expect(await listPages()).toEqual([
      {
        organization_id: "111",
        organization_urn: "urn:li:organization:111",
        page_name: "Acme",
        vanity_name: "acme",
        status: "active",
        expires_at: expect.stringMatching(/^\d{4}-\d\d-\d\dT.*Z$/),
      },
      {
        organization_id: "222",
        organization_urn: "urn:li:organization:222",
        page_name: "Globex",
        vanity_name: "globex",
        status: "active",
        expires_at: expect.stringMatching(/^\d{4}-\d\d-\d\dT.*Z$/),
      },
    ]);
  });
});

describe("oauth-callback route", () => {
  it("connects the Pages and reports them to the operator", async () => {
    world.linkedin.scriptConnect([ACME, GLOBEX]);
    const state = await startConnect();
    expect(await route("oauth-callback", { query: { code: "code-1", state, companyId: world.companyId } })).toEqual({
      status: 200,
      body: { outcome: "LinkedIn Page connected", detail: "Connected: Acme, Globex. You can close this tab." },
    });
  });
});

describe("finish routes", () => {
  it("give one status for one connect outcome", async () => {
    world.linkedin.scriptConnect([ACME]);
    world.linkedin.on("GET", ORG_ACLS_URL, () => json({ code: "NONEXISTENT_VERSION" }, 426));
    const reason =
      `LinkedIn retired API version ${LINKEDIN_VERSION} (organizationAcls 426: {"code":"NONEXISTENT_VERSION"}). ` +
      "Update LINKEDIN_VERSION and release the plugin. A reconnect does not help.";

    expect(await route("oauth-callback", { query: { code: "code-1", state: await startConnect() } })).toEqual({
      status: 502,
      body: { outcome: "Could not connect the Page", detail: reason },
    });
    expect(await route("oauth-complete", { body: { code: "code-1", state: await startConnect() } })).toEqual({
      status: 502,
      body: { error: reason, kind: "linkedin_failed" },
    });
  });

  it("answer 500 when LinkedIn refuses the client", async () => {
    world.linkedin.scriptConnect([ACME]);
    world.linkedin.on("POST", TOKEN_URL, () => json({ error: "invalid_client" }, 401));

    expect(await route("oauth-callback", { query: { code: "code-1", state: await startConnect() } })).toMatchObject({
      status: 500,
      body: { detail: expect.stringContaining("Primary Client Secret") },
    });
    expect(await route("oauth-complete", { body: { code: "code-1", state: await startConnect() } })).toMatchObject({
      status: 500,
      body: { kind: "plugin_failed" },
    });
  });
});

describe("disconnect route", () => {
  it("revokes the Page connection", async () => {
    await connect([ACME, GLOBEX]);

    expect(await route("disconnect", { params: { organizationId: "222" } })).toEqual({
      status: 200,
      body: { disconnected: "222" },
    });
    expect((await listPages())[1]).toMatchObject({ organization_id: "222", status: "revoked" });
  });

  it("answers 404 for a Page that the company never connected", async () => {
    await connect([ACME]);

    expect(await route("disconnect", { params: { organizationId: "222" } })).toEqual({
      status: 404,
      body: { error: "The company has no Page connection for Page 222." },
    });
  });
});

describe("routing", () => {
  it.each(manifest.apiRoutes.map((r) => r.routeKey))("has a handler for the manifest route %s", async (routeKey) => {
    expect(await route(routeKey)).not.toEqual({ status: 404, body: { error: `Unknown route ${routeKey}` } });
  });

  it("answers 404 for an unknown route", async () => {
    expect(await route("nope")).toEqual({ status: 404, body: { error: "Unknown route nope" } });
  });

  it("answers 503 before setup", async () => {
    vi.resetModules();
    const fresh = (await import("../src/worker.js")).default;
    expect(await fresh.definition.onApiRequest!(routeInput("list-pages", world.companyId))).toEqual({
      status: 503,
      body: { error: "Plugin worker is still starting" },
    });
  });
});
