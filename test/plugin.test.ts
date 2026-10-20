import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginApiRequestInput } from "@paperclipai/plugin-sdk";
import plugin from "../src/worker.js";
import manifest from "../src/manifest.js";
import { REQUESTED_SCOPES } from "../src/adapters/linkedin/scopes.js";
import { LINKEDIN_VERSION } from "../src/adapters/linkedin/constants.js";
import {
  ACME,
  COMMENTS_URL,
  GLOBEX,
  ORG_ACLS_URL,
  POSTS_URL,
  REACTIONS_URL,
  json,
  routeInput,
  wire,
  createWorld,
  revertToGrantBeforeFeedScopes,
  type FakePage,
  type World,
} from "./world.js";

// Smoke tests for the agent tools and API routes: wiring, wire shapes and
// the answers the worker builds. Page connection behavior is covered in
// page-connections.test.ts.

let world: World;

beforeEach(async () => {
  world = await createWorld();
  await plugin.definition.setup(world.ctx);
});

function route(
  routeKey: string,
  input: Partial<Pick<PluginApiRequestInput, "query" | "body" | "params">> = {},
  companyId = world.companyId,
) {
  return plugin.definition.onApiRequest!(routeInput(routeKey, companyId, input));
}

function tool(name: string, params: Record<string, unknown> = {}, companyId = world.companyId) {
  return world.harness.executeTool(name, params, { companyId });
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

  it("checks the scopes of the action that each tool does", async () => {
    await connect([ACME]);
    await revertToGrantBeforeFeedScopes(world);
    world.linkedin.scriptActions();

    expect(await tool("linkedin-page-post", { text: "Hi" })).toHaveProperty("content");
    for (const [name, action] of [
      ["linkedin-page-react", "react"],
      ["linkedin-page-comment", "comment"],
    ] as const) {
      expect(await tool(name, { postUrn: "urn:li:share:1", text: "Nice" })).toEqual({
        error:
          `Page 111 was connected without w_organization_social_feed, which ${action} needs. ` +
          "Reconnect the Page in Settings.",
      });
    }
    expect(world.linkedin.requestsTo(REACTIONS_URL)).toHaveLength(0);
    expect(world.linkedin.requestsTo(COMMENTS_URL)).toHaveLength(0);
  });
});

describe("linkedin-page-post", () => {
  it("posts as the acting Page and logs the activity", async () => {
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
    expect(world.harness.activity).toEqual([
      expect.objectContaining({
        message: "Posted as Acme",
        entityType: "linkedin_page_post",
        entityId: "urn:li:share:9",
        metadata: expect.objectContaining({ postUrn: "urn:li:share:9", organizationId: "111", agentId: "agent-test" }),
      }),
    ]);
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
});

describe("linkedin-page-react", () => {
  it("reacts as the acting Page", async () => {
    await connect([ACME]);
    world.linkedin.scriptActions();

    const result = await tool("linkedin-page-react", { postUrn: "urn:li:share:1" });

    expect(result).toEqual({ content: "Reacted to urn:li:share:1 as Acme." });
    const [req] = world.linkedin.requestsTo(REACTIONS_URL);
    expect(req!.url.searchParams.get("actor")).toBe("urn:li:organization:111");
    expect(JSON.parse(req!.body)).toEqual({ root: "urn:li:share:1", reactionType: "LIKE" });
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
    expect(req!.url.pathname).toBe("/rest/socialActions/urn%3Ali%3Ashare%3A1/comments");
    expect(JSON.parse(req!.body)).toEqual({
      actor: "urn:li:organization:111",
      object: "urn:li:share:1",
      message: { text: "Nice" },
    });
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

  it("requires code and state", async () => {
    expect(await route("oauth-complete", { body: {} })).toEqual({
      status: 400,
      body: { error: "code and state are required" },
    });
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

  it("reports a declined authorization", async () => {
    const query = { error: "user_cancelled_login", error_description: "The user cancelled" };
    expect(await route("oauth-callback", { query })).toEqual({
      status: 400,
      body: { outcome: "LinkedIn authorization was declined", detail: "user_cancelled_login: The user cancelled" },
    });
  });

  it("reports a missing code", async () => {
    expect(await route("oauth-callback", { query: {} })).toEqual({
      status: 400,
      body: { outcome: "Missing code or state", detail: "LinkedIn did not return an authorization code." },
    });
  });

  it("reports a failed connect", async () => {
    expect(await route("oauth-callback", { query: { code: "code-1", state: "nope" } })).toEqual({
      status: 400,
      body: { outcome: "Could not connect the Page", detail: "Unknown or expired OAuth state" },
    });
  });

  it("names the developer action when LinkedIn retired the API version", async () => {
    world.linkedin.scriptConnect([ACME]);
    world.linkedin.on("GET", ORG_ACLS_URL, () => json({ code: "NONEXISTENT_VERSION" }, 426));
    const state = await startConnect();

    expect(await route("oauth-callback", { query: { code: "code-1", state } })).toEqual({
      status: 400,
      body: {
        outcome: "Could not connect the Page",
        detail:
          `LinkedIn retired API version ${LINKEDIN_VERSION} (organizationAcls 426: {"code":"NONEXISTENT_VERSION"}). ` +
          "Update LINKEDIN_VERSION and release the plugin. A reconnect does not help.",
      },
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
});

describe("routing", () => {
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
