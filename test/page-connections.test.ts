import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPageConnections, type PageConnections } from "../src/page-connections.js";
import { openToken } from "../src/crypto.js";
import { REQUESTED_SCOPES } from "../src/adapters/linkedin/scopes.js";
import { LinkedInApiError } from "../src/adapters/linkedin/errors.js";
import {
  ACME,
  GLOBEX,
  ONE_MINUTE_S,
  REACTIONS_URL,
  SIXTY_DAYS_S,
  json,
  pluginConfig,
  tokenResponse,
  createWorld,
  revertToGrantBeforeFeedScopes,
  type FakePage,
  type World,
} from "./world.js";

const REDIRECT_PATH = "/api/plugins/sirantd.linkedin-org/api/oauth/callback";
const NO_PAGE = "No LinkedIn Page is connected for this company. Connect one in Settings first.";

let world: World;
let pages: PageConnections;

beforeEach(async () => {
  world = await createWorld();
  world.linkedin.scriptActions();
  pages = createPageConnections(world.ctx, world.linkedin.fetch);
});

afterEach(() => world.close());

async function startConnect(): Promise<string> {
  const { authorizationUrl } = await pages.startConnect(world.companyId, "operator-1");
  return new URL(authorizationUrl).searchParams.get("state")!;
}

async function connect(fakePages: FakePage[], tokens: Record<string, unknown> = {}) {
  world.linkedin.scriptConnect(fakePages, tokens);
  return pages.finishConnect(world.companyId, "code-1", await startConnect(), "operator-1");
}

/** The acting Page that actAs hands to its work. */
function actAs(organizationId?: string) {
  return pages.actAs(world.companyId, organizationId, "post", async (page) => page);
}

/** React once as the acting Page. */
function react(organizationId?: string) {
  return pages.actAs(world.companyId, organizationId, "react", (page) => page.react("urn:li:share:1"));
}

/** The token that the acting Page sent with each reaction, oldest first. */
function reactionTokens() {
  return world.linkedin.requestsTo(REACTIONS_URL).map((r) => r.headers.Authorization);
}

async function statusOf(organizationId: string) {
  return (await pages.list(world.companyId)).find((p) => p.organizationId === organizationId)?.status;
}

describe("actAs", () => {
  it("acts as the Page with the stored token while it is valid", async () => {
    await connect([ACME]);

    const page = await actAs();
    expect(page).toMatchObject({
      organizationId: "111",
      organizationUrn: "urn:li:organization:111",
      displayName: "Acme",
    });
    expect(page).not.toHaveProperty("accessToken");
    await react();
    expect(reactionTokens()).toEqual(["Bearer access-1"]);
    expect(world.linkedin.tokenCalls()).toHaveLength(1);
  });

  it("names an unnamed Page by its organization URN", async () => {
    await connect([{ id: "333", name: null }]);
    expect((await actAs()).displayName).toBe("urn:li:organization:333");
  });

  describe("choosing the acting Page", () => {
    it("uses the named Page", async () => {
      await connect([ACME, GLOBEX]);
      expect((await actAs("222")).organizationId).toBe("222");
    });

    it("uses the Page that an Organization URN names", async () => {
      await connect([ACME, GLOBEX]);
      expect((await actAs("urn:li:organization:222")).organizationId).toBe("222");
    });

    it.each(["urn:li:share:1", "acme"])("refuses %s, which is not an organization reference", async (ref) => {
      await connect([ACME]);
      await expect(actAs(ref)).rejects.toThrow(
        `${ref} is not an organization id or an Organization URN (urn:li:organization:{id}).`,
      );
    });

    it("uses the default Page when the call names none", async () => {
      world.configs.set(world.companyId, pluginConfig({ defaultOrganizationUrn: "urn:li:organization:222" }));
      await connect([ACME, GLOBEX]);
      expect((await actAs()).organizationId).toBe("222");
    });

    it("uses the default Page when the call names an empty reference", async () => {
      world.configs.set(world.companyId, pluginConfig({ defaultOrganizationUrn: "urn:li:organization:222" }));
      await connect([ACME, GLOBEX]);
      expect((await actAs("")).organizationId).toBe("222");
    });

    it("uses a default Page set as an organization id", async () => {
      world.configs.set(world.companyId, pluginConfig({ defaultOrganizationUrn: "222" }));
      await connect([ACME, GLOBEX]);
      expect((await actAs()).organizationId).toBe("222");
    });

    it("names the setting when the default Page is not an organization reference", async () => {
      world.configs.set(world.companyId, pluginConfig({ defaultOrganizationUrn: "acme" }));
      await connect([ACME, GLOBEX]);
      await expect(actAs()).rejects.toThrow(
        "The default Page acme in the plugin settings is not an organization id or an Organization URN. " +
          "Correct it in Settings.",
      );
    });

    it("prefers the named Page over the default Page", async () => {
      world.configs.set(world.companyId, pluginConfig({ defaultOrganizationUrn: "urn:li:organization:222" }));
      await connect([ACME, GLOBEX]);
      expect((await actAs("111")).organizationId).toBe("111");
    });

    it("refuses to guess between several active Pages", async () => {
      await connect([ACME, GLOBEX]);
      await expect(actAs()).rejects.toThrow(
        "Multiple LinkedIn Pages are connected. Pass organizationId explicitly, " +
          "or set a default Page in the plugin settings.",
      );
    });

    it("fails when no Page is connected", async () => {
      await expect(actAs()).rejects.toThrow(NO_PAGE);
    });

    it("fails when the named Page is not connected", async () => {
      await connect([ACME]);
      await expect(actAs("999")).rejects.toThrow(
        "No active connection for organization 999. Connect the Page in Settings first.",
      );
    });

    it("skips a Page that is not active", async () => {
      await connect([ACME, GLOBEX]);
      await pages.disconnect(world.companyId, "222");
      expect((await actAs()).organizationId).toBe("111");
    });
  });

  describe("token freshness", () => {
    it("refreshes a token near expiry, stores it and logs the refresh", async () => {
      await connect([ACME], { expires_in: ONE_MINUTE_S });
      world.linkedin.scriptRefresh(() =>
        tokenResponse({ access_token: "access-2", expires_in: SIXTY_DAYS_S, refresh_token: undefined }),
      );

      await react();
      await react();

      expect(reactionTokens()).toEqual(["Bearer access-2", "Bearer access-2"]);
      expect(world.linkedin.tokenCalls()).toHaveLength(2);
      expect(Object.fromEntries(world.linkedin.tokenCalls()[1]!)).toEqual({
        grant_type: "refresh_token",
        refresh_token: "refresh-1",
        client_id: "client-id",
        client_secret: "client-secret",
      });
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

      await actAs();
      await actAs();

      const refreshTokens = world.linkedin.tokenCalls().slice(1).map((c) => c.get("refresh_token"));
      expect(refreshTokens).toEqual(["refresh-1", "refresh-1"]);
    });

    it("shares one refresh between concurrent calls", async () => {
      await connect([ACME], { expires_in: ONE_MINUTE_S });
      world.linkedin.scriptRefresh(() => tokenResponse({ access_token: "access-2" }));

      await Promise.all([react(), react()]);

      expect(reactionTokens()).toEqual(["Bearer access-2", "Bearer access-2"]);
      expect(world.linkedin.tokenCalls().map((call) => call.get("grant_type"))).toEqual([
        "authorization_code",
        "refresh_token",
      ]);
    });

    it("expires the Page connection when no refresh token is stored", async () => {
      await connect([ACME], { expires_in: ONE_MINUTE_S, refresh_token: undefined });

      await expect(actAs()).rejects.toThrow(
        "LinkedIn token for Page 111 expired and no refresh token is stored. Reconnect the Page in Settings.",
      );
      expect(await statusOf("111")).toBe("expired");
      await expect(actAs()).rejects.toThrow(NO_PAGE);
    });

    it("expires the Page connection when LinkedIn refuses the refresh token", async () => {
      await connect([ACME], { expires_in: ONE_MINUTE_S });
      world.linkedin.scriptRefresh(() => json({ error: "invalid_grant" }, 400));

      await expect(actAs()).rejects.toThrow(
        'Refreshing the LinkedIn token for Page 111 failed (LinkedIn token endpoint 400: {"error":"invalid_grant"}). ' +
          "Reconnect the Page in Settings.",
      );
      expect(await statusOf("111")).toBe("expired");
    });

    it.each([
      ["a LinkedIn outage", () => json({ message: "Service Unavailable" }, 503)],
      ["a wrong Client Secret", () => json({ error: "invalid_client" }, 401)],
      [
        "a network error",
        () => {
          throw new TypeError("fetch failed");
        },
      ],
    ])("keeps the Page connection active after %s", async (_cause, respond) => {
      await connect([ACME], { expires_in: ONE_MINUTE_S });
      world.linkedin.scriptRefresh(respond);

      await expect(actAs()).rejects.toThrow(
        /^Refreshing the LinkedIn token for Page 111 failed \(.+\)\. The Page connection stays active\.$/,
      );
      expect(await statusOf("111")).toBe("active");
    });

    it("names the Client Secret when LinkedIn refuses the client", async () => {
      await connect([ACME], { expires_in: ONE_MINUTE_S });
      world.linkedin.scriptRefresh(() => json({ error: "invalid_client" }, 401));

      await expect(actAs()).rejects.toThrow("confirm it matches the app's current Primary Client Secret");
    });

    it("tries the refresh again on the next call after a failed refresh", async () => {
      await connect([ACME], { expires_in: ONE_MINUTE_S });
      world.linkedin.scriptRefresh(() => json({}, 503));
      await expect(actAs()).rejects.toThrow();

      world.linkedin.scriptRefresh(() => tokenResponse({ access_token: "access-2" }));

      await react();
      expect(reactionTokens()).toEqual(["Bearer access-2"]);
    });
  });

  describe("the work", () => {
    it("returns the result of the work", async () => {
      await connect([ACME]);
      expect(
        await pages.actAs(world.companyId, undefined, "post", async (page) => `posted as ${page.displayName}`),
      ).toBe("posted as Acme");
    });

    it("expires the Page connection when LinkedIn rejects the token", async () => {
      await connect([ACME]);
      const rejected = new LinkedInApiError(401, 'LinkedIn publish 401: {"code":"REVOKED_ACCESS_TOKEN"}');

      await expect(pages.actAs(world.companyId, undefined, "post", () => Promise.reject(rejected))).rejects.toThrow(
        'LinkedIn rejected the token for Page 111 (LinkedIn publish 401: {"code":"REVOKED_ACCESS_TOKEN"}). ' +
          "Reconnect the Page in Settings.",
      );
      expect(await statusOf("111")).toBe("expired");
    });

    it("names the action, the Page and the likely causes when LinkedIn refuses the action", async () => {
      await connect([ACME]);
      const denied = new LinkedInApiError(403, "LinkedIn react 403: ACCESS_DENIED");

      await expect(pages.actAs(world.companyId, undefined, "react", () => Promise.reject(denied))).rejects.toThrow(
        "LinkedIn refused react as Page 111 (LinkedIn react 403: ACCESS_DENIED). " +
          "The Page connection holds the scopes that the plugin requires for react, so the authorizing " +
          "member may no longer administer the Page, or LinkedIn may have withdrawn the app's access. " +
          "Check both, then reconnect the Page in Settings.",
      );
      expect(await statusOf("111")).toBe("active");
    });

    it("names the rate limit and keeps the Page connection active", async () => {
      await connect([ACME]);
      const limited = new LinkedInApiError(429, "LinkedIn comment 429: TOO_MANY_REQUESTS");

      await expect(pages.actAs(world.companyId, undefined, "comment", () => Promise.reject(limited))).rejects.toThrow(
        "LinkedIn refused comment as Page 111 because of its rate limit (LinkedIn comment 429: TOO_MANY_REQUESTS). " +
          "Try again later.",
      );
      expect(await statusOf("111")).toBe("active");
    });

    it.each([426, 500])("passes a %i through and keeps the Page connection active", async (status) => {
      await connect([ACME]);
      const failed = new LinkedInApiError(status, `LinkedIn publish ${status}: failed`);

      await expect(pages.actAs(world.companyId, undefined, "post", () => Promise.reject(failed))).rejects.toBe(failed);
      expect(await statusOf("111")).toBe("active");
    });
  });

  describe.each(["array", "text"] as const)("scopes, with the host returning text[] as %s", (form) => {
    beforeEach(() => {
      world.textArrays = form;
    });

    it("allows react to a Page connection with the full grant", async () => {
      await connect([ACME]);
      await react();
      expect(reactionTokens()).toEqual(["Bearer access-1"]);
    });

    it("refuses post to a Page connection with w_organization_social_feed but not w_organization_social", async () => {
      await connect([ACME]);
      // Connect refuses this grant, so only a stored row can hold it.
      await world.sql(`update ${world.ctx.db.namespace}.page_connections set scopes = $1`, [
        ["w_organization_social_feed", "rw_organization_admin"],
      ]);

      await expect(actAs()).rejects.toThrow(
        "Page 111 was connected without w_organization_social, which post needs. Reconnect the Page in Settings.",
      );
    });

    it("refuses an action without its scopes before it refreshes the token", async () => {
      await connect([ACME], { expires_in: ONE_MINUTE_S });
      await revertToGrantBeforeFeedScopes(world);

      await expect(pages.actAs(world.companyId, undefined, "react", async (page) => page)).rejects.toThrow(
        "Page 111 was connected without w_organization_social_feed, which react needs. " +
          "Reconnect the Page in Settings.",
      );
      expect(world.linkedin.tokenCalls()).toHaveLength(1);
      expect(await statusOf("111")).toBe("active");
    });

    it("allows an action whose scopes the Page connection holds", async () => {
      await connect([ACME]);
      await revertToGrantBeforeFeedScopes(world);
      expect((await actAs()).organizationId).toBe("111");
    });
  });
});

describe("list", () => {
  it("lists every Page connection by name with unnamed Pages last", async () => {
    await connect([GLOBEX, { id: "333", name: null }, ACME]);
    await pages.disconnect(world.companyId, "222");

    expect(await pages.list(world.companyId)).toEqual([
      {
        organizationId: "111",
        organizationUrn: "urn:li:organization:111",
        name: "Acme",
        vanityName: "acme",
        displayName: "Acme",
        status: "active",
        expiresAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT.*Z$/),
      },
      expect.objectContaining({ organizationId: "222", displayName: "Globex", status: "revoked" }),
      expect.objectContaining({ organizationId: "333", name: null, displayName: "urn:li:organization:333" }),
    ]);
  });

  it("lists nothing for a company with no Page connection", async () => {
    expect(await pages.list(world.companyId)).toEqual([]);
  });
});

describe("startConnect", () => {
  it("returns the authorization URL and stores the OAuth state", async () => {
    const { authorizationUrl, scopes } = await pages.startConnect(world.companyId, "operator-1");

    expect(scopes).toEqual(REQUESTED_SCOPES);
    const url = new URL(authorizationUrl);
    expect(url.origin + url.pathname).toBe("https://www.linkedin.com/oauth/v2/authorization");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("client-id");
    expect(url.searchParams.get("redirect_uri")).toBe(
      `https://paperclip.example.com${REDIRECT_PATH}?companyId=${world.companyId}`,
    );
    expect(url.searchParams.get("scope")).toBe(REQUESTED_SCOPES.join(" "));
    const state = url.searchParams.get("state")!;
    expect(world.harness.getState({ scopeKind: "company", scopeId: world.companyId, stateKey: `oauth:${state}` }))
      .toEqual({ createdAt: expect.any(Number), actorId: "operator-1" });
  });

  it("fails for a company with no plugin config", async () => {
    const other = await world.addCompany();
    await expect(pages.startConnect(other, "operator-1")).rejects.toThrow(
      "LinkedIn Page plugin is not configured for this company",
    );
  });

  it("connects with a default Page that is not an organization reference", async () => {
    world.configs.set(world.companyId, pluginConfig({ defaultOrganizationUrn: "acme" }));
    expect(await connect([ACME])).toHaveLength(1);
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

describe("finishConnect", () => {
  it("creates one active Page connection for each administered Page", async () => {
    const connected = await connect([ACME, GLOBEX]);

    expect(connected).toEqual([
      { organizationUrn: "urn:li:organization:111", organizationId: "111", name: "Acme", vanityName: "acme" },
      { organizationUrn: "urn:li:organization:222", organizationId: "222", name: "Globex", vanityName: "globex" },
    ]);
    expect(Object.fromEntries(world.linkedin.tokenCalls()[0]!)).toEqual({
      grant_type: "authorization_code",
      code: "code-1",
      client_id: "client-id",
      client_secret: "client-secret",
      redirect_uri: `https://paperclip.example.com${REDIRECT_PATH}?companyId=${world.companyId}`,
    });
    expect((await pages.list(world.companyId)).map((p) => [p.organizationId, p.status])).toEqual([
      ["111", "active"],
      ["222", "active"],
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

  it("stores the granted scopes", async () => {
    const granted = ["w_organization_social", "w_organization_social_feed", "rw_organization_admin"];
    await connect([ACME], { scope: granted.join(" ") });
    const [row] = await world.sql<{ scopes: string[] }>(
      `select scopes from ${world.ctx.db.namespace}.page_connections`,
    );
    expect(row!.scopes).toEqual(granted);
  });

  it("deletes the OAuth state after a successful connect", async () => {
    world.linkedin.scriptConnect([ACME]);
    const state = await startConnect();
    await pages.finishConnect(world.companyId, "code-1", state, "operator-1");
    expect(
      world.harness.getState({ scopeKind: "company", scopeId: world.companyId, stateKey: `oauth:${state}` }),
    ).toBeFalsy();
  });

  it("renews an existing Page connection in place", async () => {
    await connect([ACME], { expires_in: ONE_MINUTE_S, refresh_token: undefined });
    await expect(actAs()).rejects.toThrow();
    expect(await statusOf("111")).toBe("expired");

    await connect([ACME], { access_token: "access-2" });

    expect((await pages.list(world.companyId)).map((p) => [p.organizationId, p.status])).toEqual([["111", "active"]]);
    await react();
    expect(reactionTokens()).toEqual(["Bearer access-2"]);
  });

  it("rejects an unknown OAuth state", async () => {
    await expect(pages.finishConnect(world.companyId, "code-1", "nope", "operator-1")).rejects.toThrow(
      "Unknown or expired OAuth state",
    );
  });

  describe("OAuth state age", () => {
    async function stateCreatedMinutesAgo(minutes: number): Promise<string> {
      const state = await startConnect();
      await world.ctx.state.set(
        { scopeKind: "company", scopeId: world.companyId, stateKey: `oauth:${state}` },
        { createdAt: Date.now() - minutes * 60 * 1000, actorId: "operator-1" },
      );
      return state;
    }

    it("accepts an OAuth state younger than ten minutes", async () => {
      world.linkedin.scriptConnect([ACME]);
      const state = await stateCreatedMinutesAgo(9);
      expect(await pages.finishConnect(world.companyId, "code-1", state, "operator-1")).toHaveLength(1);
    });

    it("rejects and deletes an OAuth state older than ten minutes", async () => {
      world.linkedin.scriptConnect([ACME]);
      const state = await stateCreatedMinutesAgo(11);

      await expect(pages.finishConnect(world.companyId, "code-1", state, "operator-1")).rejects.toThrow(
        "Unknown or expired OAuth state",
      );
      expect(world.linkedin.tokenCalls()).toHaveLength(0);
      expect(
        world.harness.getState({ scopeKind: "company", scopeId: world.companyId, stateKey: `oauth:${state}` }),
      ).toBeFalsy();
    });
  });

  it("rejects a grant without the organization feed scope", async () => {
    await expect(
      connect([ACME], { scope: "r_organization_social,w_organization_social,rw_organization_admin" }),
    ).rejects.toThrow(/^LinkedIn did not grant w_organization_social_feed\. /);
    expect(await pages.list(world.companyId)).toEqual([]);
  });

  it("rejects a grant that names no scopes", async () => {
    await expect(connect([ACME], { scope: undefined })).rejects.toThrow(
      /^LinkedIn did not report the granted scopes/,
    );
    expect(await pages.list(world.companyId)).toEqual([]);
  });

  it("rejects a member who administers no Page", async () => {
    await expect(connect([])).rejects.toThrow(
      "The authorizing member does not administer any LinkedIn Page. " +
        "Grant them an ADMINISTRATOR role on the Page and reconnect.",
    );
  });
});

describe("disconnect", () => {
  it("revokes the Page connection and clears its tokens", async () => {
    await connect([ACME, GLOBEX]);

    await pages.disconnect(world.companyId, "222");

    expect(await statusOf("222")).toBe("revoked");
    expect(await statusOf("111")).toBe("active");
    const [row] = await world.sql<{ access_token_sealed: string; refresh_token_sealed: string | null }>(
      `select access_token_sealed, refresh_token_sealed from ${world.ctx.db.namespace}.page_connections
        where organization_id = '222'`,
    );
    expect(row).toEqual({ access_token_sealed: "", refresh_token_sealed: null });
  });

  it("revokes the Page that an Organization URN names", async () => {
    await connect([ACME, GLOBEX]);
    await pages.disconnect(world.companyId, "urn:li:organization:222");
    expect(await statusOf("222")).toBe("revoked");
  });

  it("refuses a reference that is not an organization reference", async () => {
    await connect([ACME]);
    await expect(pages.disconnect(world.companyId, "acme")).rejects.toThrow(
      "acme is not an organization id or an Organization URN (urn:li:organization:{id}).",
    );
  });
});

describe("configuration", () => {
  it("fails for a company with no plugin config", async () => {
    const other = await world.addCompany();
    await expect(pages.actAs(other, undefined, "post", async (page) => page)).rejects.toThrow(
      "LinkedIn Page plugin is not configured for this company",
    );
  });
});
