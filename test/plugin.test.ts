import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginApiRequestInput } from "@paperclipai/plugin-sdk";
import plugin from "../src/worker.js";
import { openToken } from "../src/crypto.js";
import { LINKEDIN_ORG_SCOPES } from "../src/adapters/linkedin/constants.js";
import {
  ACME,
  COMMENTS_URL,
  GLOBEX,
  ONE_MINUTE_S,
  POSTS_URL,
  REACTIONS_URL,
  SIXTY_DAYS_S,
  json,
  pluginConfig,
  routeInput,
  tokenResponse,
  wire,
  createWorld,
  type FakePage,
  type World,
} from "./world.js";

const REDIRECT_PATH = "/api/plugins/sirantd.linkedin-org/api/oauth/callback";

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

async function connect(pages: FakePage[], tokens: Record<string, unknown> = {}) {
  world.linkedin.scriptConnect(pages, tokens);
  const state = await startConnect();
  return route("oauth-complete", { body: { code: "code-1", state } });
}

async function listPages() {
  const res = await route("list-pages", { query: { companyId: world.companyId } });
  return (wire(res.body) as { pages: Array<Record<string, unknown>> }).pages;
}

function lastPostBody(): Record<string, unknown> {
  return JSON.parse(world.linkedin.requestsTo(POSTS_URL).at(-1)!.body);
}

describe("linkedin-page-post", () => {
  it("posts as the only connected Page with the stored token and logs the activity", async () => {
    await connect([ACME]);
    world.linkedin.scriptActions("urn:li:share:9");

    const result = await tool("linkedin-page-post", { text: "Hello" });

    expect(result).toEqual({
      content: "Published as Acme: https://www.linkedin.com/feed/update/urn:li:share:9/",
      data: { postUrn: "urn:li:share:9", permalink: "https://www.linkedin.com/feed/update/urn:li:share:9/" },
    });
    const [post] = world.linkedin.requestsTo(POSTS_URL);
    expect(post!.headers.Authorization).toBe("Bearer access-1");
    expect(lastPostBody()).toMatchObject({ author: "urn:li:organization:111", commentary: "Hello", visibility: "PUBLIC" });
    expect(world.linkedin.tokenCalls()).toHaveLength(1);
    expect(world.harness.activity).toEqual([
      expect.objectContaining({
        message: "Posted as Acme",
        entityType: "linkedin_page_post",
        entityId: "urn:li:share:9",
        metadata: expect.objectContaining({ postUrn: "urn:li:share:9", organizationId: "111", agentId: "agent-test" }),
      }),
    ]);
  });
});

describe("linkedin-page-react", () => {
  it("reacts as the Page", async () => {
    await connect([ACME]);
    world.linkedin.scriptActions();

    const result = await tool("linkedin-page-react", { postUrn: "urn:li:share:1" });

    expect(result).toEqual({ content: "Reacted to urn:li:share:1 as Acme." });
    const [req] = world.linkedin.requestsTo(REACTIONS_URL);
    expect(req!.url.searchParams.get("actor")).toBe("urn:li:organization:111");
    expect(JSON.parse(req!.body)).toEqual({ root: "urn:li:share:1", reactionType: "LIKE" });
  });
});

describe("linkedin-page-comment", () => {
  it("comments as the Page", async () => {
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
  it("lists the Pages by name with unnamed Pages last", async () => {
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

describe("choosing the acting Page", () => {
  beforeEach(() => world.linkedin.scriptActions());

  it("uses the named Page", async () => {
    await connect([ACME, GLOBEX]);
    const result = await tool("linkedin-page-post", { text: "Hi", organizationId: "222" });
    expect(result).toMatchObject({ content: expect.stringMatching(/^Published as Globex: /) });
    expect(lastPostBody().author).toBe("urn:li:organization:222");
  });

  it("uses the default Page when the call names none", async () => {
    world.configs.set(world.companyId, pluginConfig({ defaultOrganizationUrn: "urn:li:organization:222" }));
    await connect([ACME, GLOBEX]);
    await tool("linkedin-page-post", { text: "Hi" });
    expect(lastPostBody().author).toBe("urn:li:organization:222");
  });

  it("prefers the named Page over the default Page", async () => {
    world.configs.set(world.companyId, pluginConfig({ defaultOrganizationUrn: "urn:li:organization:222" }));
    await connect([ACME, GLOBEX]);
    await tool("linkedin-page-post", { text: "Hi", organizationId: "111" });
    expect(lastPostBody().author).toBe("urn:li:organization:111");
  });

  it("refuses to guess between several active Pages", async () => {
    await connect([ACME, GLOBEX]);
    expect(await tool("linkedin-page-post", { text: "Hi" })).toEqual({
      error:
        "Multiple LinkedIn Pages are connected. Pass organizationId explicitly, " +
        "or set a default Page in the plugin settings.",
    });
    expect(world.linkedin.requestsTo(POSTS_URL)).toHaveLength(0);
  });

  it("fails when no Page is connected", async () => {
    expect(await tool("linkedin-page-post", { text: "Hi" })).toEqual({
      error: "No LinkedIn Page is connected for this company. Connect one in Settings first.",
    });
  });

  it("fails when the named Page is not connected", async () => {
    await connect([ACME]);
    expect(await tool("linkedin-page-post", { text: "Hi", organizationId: "999" })).toEqual({
      error: "No active connection for organization 999. Connect the Page in Settings first.",
    });
  });

  it("skips a Page that is not active", async () => {
    await connect([ACME, GLOBEX]);
    await route("disconnect", { params: { organizationId: "222" } });
    await tool("linkedin-page-post", { text: "Hi" });
    expect(lastPostBody().author).toBe("urn:li:organization:111");
  });
});

describe("token freshness", () => {
  beforeEach(() => world.linkedin.scriptActions());

  it("refreshes a token near expiry, stores it and logs the refresh", async () => {
    await connect([ACME], { expires_in: ONE_MINUTE_S });
    world.linkedin.scriptRefresh(() =>
      tokenResponse({ access_token: "access-2", expires_in: SIXTY_DAYS_S, refresh_token: undefined }),
    );

    await tool("linkedin-page-post", { text: "first" });
    await tool("linkedin-page-post", { text: "second" });

    const refresh = world.linkedin.tokenCalls()[1]!;
    expect(Object.fromEntries(refresh)).toEqual({
      grant_type: "refresh_token",
      refresh_token: "refresh-1",
      client_id: "client-id",
      client_secret: "client-secret",
    });
    expect(world.linkedin.tokenCalls()).toHaveLength(2);
    const auth = world.linkedin.requestsTo(POSTS_URL).map((r) => r.headers.Authorization);
    expect(auth).toEqual(["Bearer access-2", "Bearer access-2"]);
    expect(world.harness.logs).toContainEqual({
      level: "info",
      message: "refreshed LinkedIn Page token",
      meta: { companyId: world.companyId, organizationId: "111" },
    });
  });

  it("keeps the stored refresh token when LinkedIn returns none", async () => {
    await connect([ACME], { expires_in: ONE_MINUTE_S });
    world.linkedin.scriptRefresh(() =>
      tokenResponse({ access_token: "access-2", expires_in: ONE_MINUTE_S, refresh_token: undefined }),
    );

    await tool("linkedin-page-post", { text: "first" });
    await tool("linkedin-page-post", { text: "second" });

    const refreshTokens = world.linkedin.tokenCalls().slice(1).map((c) => c.get("refresh_token"));
    expect(refreshTokens).toEqual(["refresh-1", "refresh-1"]);
  });

  it("expires the Page connection when no refresh token is stored", async () => {
    await connect([ACME], { expires_in: ONE_MINUTE_S, refresh_token: undefined });

    expect(await tool("linkedin-page-post", { text: "Hi" })).toEqual({
      error: "LinkedIn token for Page 111 expired and no refresh token is stored. Reconnect the Page in Settings.",
    });
    expect((await listPages())[0]).toMatchObject({ status: "expired" });
    expect(await tool("linkedin-page-post", { text: "Hi" })).toEqual({
      error: "No LinkedIn Page is connected for this company. Connect one in Settings first.",
    });
  });

  it("expires the Page connection when the refresh fails", async () => {
    await connect([ACME], { expires_in: ONE_MINUTE_S });
    world.linkedin.scriptRefresh(() => json({ error: "invalid_grant" }, 400));

    expect(await tool("linkedin-page-post", { text: "Hi" })).toEqual({
      error:
        'Refreshing the LinkedIn token for Page 111 failed (LinkedIn token endpoint 400: {"error":"invalid_grant"}). ' +
        "Reconnect the Page in Settings.",
    });
    expect((await listPages())[0]).toMatchObject({ status: "expired" });
  });
});

describe("configuration", () => {
  it("fails a tool call for a company with no plugin config", async () => {
    const other = await world.addCompany();
    expect(await tool("linkedin-page-post", { text: "Hi" }, other)).toEqual({
      error: "LinkedIn Page plugin is not configured for this company",
    });
  });

  it("trims secret values", async () => {
    world.secrets["client-id"] = "client-id\n";
    world.secrets["client-secret"] = "client-secret\n";
    await connect([ACME]);
    const exchange = world.linkedin.tokenCalls()[0]!;
    expect(exchange.get("client_id")).toBe("client-id");
    expect(exchange.get("client_secret")).toBe("client-secret");
  });
});

describe("oauth-start route", () => {
  it("returns the authorization URL and stores the OAuth state", async () => {
    const res = await route("oauth-start", { body: { companyId: world.companyId } });

    expect(res.status).toBe(200);
    const body = res.body as { authorizationUrl: string; scopes: string[] };
    expect(body.scopes).toEqual([...LINKEDIN_ORG_SCOPES]);
    const url = new URL(body.authorizationUrl);
    expect(url.origin + url.pathname).toBe("https://www.linkedin.com/oauth/v2/authorization");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("client-id");
    expect(url.searchParams.get("redirect_uri")).toBe(
      `https://paperclip.example.com${REDIRECT_PATH}?companyId=${world.companyId}`,
    );
    expect(url.searchParams.get("scope")).toBe(LINKEDIN_ORG_SCOPES.join(" "));
    const state = url.searchParams.get("state")!;
    expect(world.harness.getState({ scopeKind: "company", scopeId: world.companyId, stateKey: `oauth:${state}` }))
      .toEqual({ createdAt: expect.any(Number), actorId: "operator-1" });
  });

  it("answers 500 for a company with no plugin config", async () => {
    const other = await world.addCompany();
    expect(await route("oauth-start", {}, other)).toEqual({
      status: 500,
      body: { error: "LinkedIn Page plugin is not configured for this company" },
    });
  });
});

describe("oauth-complete route", () => {
  it("stores one active Page connection for each administered Page", async () => {
    const res = await connect([ACME, GLOBEX]);

    expect(res).toEqual({
      status: 200,
      body: {
        connected: [
          { organizationUrn: "urn:li:organization:111", organizationId: "111", name: "Acme", vanityName: "acme" },
          { organizationUrn: "urn:li:organization:222", organizationId: "222", name: "Globex", vanityName: "globex" },
        ],
      },
    });
    expect(Object.fromEntries(world.linkedin.tokenCalls()[0]!)).toEqual({
      grant_type: "authorization_code",
      code: "code-1",
      client_id: "client-id",
      client_secret: "client-secret",
      redirect_uri: `https://paperclip.example.com${REDIRECT_PATH}?companyId=${world.companyId}`,
    });
    expect(await listPages()).toEqual([
      {
        organization_id: "111",
        organization_urn: "urn:li:organization:111",
        page_name: "Acme",
        vanity_name: "acme",
        status: "active",
        expires_at: expect.any(String),
      },
      {
        organization_id: "222",
        organization_urn: "urn:li:organization:222",
        page_name: "Globex",
        vanity_name: "globex",
        status: "active",
        expires_at: expect.any(String),
      },
    ]);
  });

  it("stores the tokens sealed under the DEK", async () => {
    await connect([ACME]);
    const [row] = await world.sql<{ access_token_sealed: string; refresh_token_sealed: string }>(
      `select access_token_sealed, refresh_token_sealed from ${world.ctx.db.namespace}.page_connections`,
    );
    expect(row!.access_token_sealed).not.toContain("access-1");
    expect(openToken(row!.access_token_sealed, world.dek)).toBe("access-1");
    expect(openToken(row!.refresh_token_sealed, world.dek)).toBe("refresh-1");
  });

  it("deletes the OAuth state after a successful connect", async () => {
    world.linkedin.scriptConnect([ACME]);
    const state = await startConnect();
    await route("oauth-complete", { body: { code: "code-1", state } });
    expect(
      world.harness.getState({ scopeKind: "company", scopeId: world.companyId, stateKey: `oauth:${state}` }),
    ).toBeFalsy();
  });

  it("renews an existing Page connection in place", async () => {
    world.linkedin.scriptActions();
    await connect([ACME], { expires_in: ONE_MINUTE_S, refresh_token: undefined });
    await tool("linkedin-page-post", { text: "Hi" });
    expect((await listPages())[0]).toMatchObject({ status: "expired" });

    await connect([ACME], { access_token: "access-2" });

    expect(await listPages()).toEqual([expect.objectContaining({ organization_id: "111", status: "active" })]);
    await tool("linkedin-page-post", { text: "Hi" });
    expect(world.linkedin.requestsTo(POSTS_URL).at(-1)!.headers.Authorization).toBe("Bearer access-2");
  });

  it("rejects an unknown OAuth state", async () => {
    expect(await route("oauth-complete", { body: { code: "code-1", state: "nope" } })).toEqual({
      status: 500,
      body: { error: "Unknown or expired OAuth state" },
    });
  });

  it("requires code and state", async () => {
    expect(await route("oauth-complete", { body: {} })).toEqual({
      status: 400,
      body: { error: "code and state are required" },
    });
  });

  it("rejects a grant without the organization feed scope", async () => {
    const res = await connect([ACME], { scope: "r_organization_social,w_organization_social,rw_organization_admin" });
    expect(res.status).toBe(500);
    expect((res.body as { error: string }).error).toMatch(/^LinkedIn did not grant w_organization_social_feed\. /);
    expect(await listPages()).toEqual([]);
  });

  it("rejects a member who administers no Page", async () => {
    expect(await connect([])).toEqual({
      status: 500,
      body: {
        error:
          "The authorizing member does not administer any LinkedIn Page. " +
          "Grant them an ADMINISTRATOR role on the Page and reconnect.",
      },
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
});

describe("disconnect route", () => {
  it("revokes the Page connection and clears its tokens", async () => {
    await connect([ACME, GLOBEX]);

    expect(await route("disconnect", { params: { organizationId: "222" } })).toEqual({
      status: 200,
      body: { disconnected: "222" },
    });
    expect((await listPages())[1]).toMatchObject({ organization_id: "222", status: "revoked" });
    const [row] = await world.sql<{ access_token_sealed: string; refresh_token_sealed: string | null }>(
      `select access_token_sealed, refresh_token_sealed from ${world.ctx.db.namespace}.page_connections
        where organization_id = '222'`,
    );
    expect(row).toEqual({ access_token_sealed: "", refresh_token_sealed: null });
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
