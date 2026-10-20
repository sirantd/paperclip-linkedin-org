import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createPageConnections, type LinkedInRedirect, type PageConnections } from "../src/page-connections.js";
import { openToken } from "../src/crypto.js";
import { REQUESTED_SCOPES } from "../src/adapters/linkedin/scopes.js";
import { LinkedInApiError } from "../src/adapters/linkedin/errors.js";
import { LINKEDIN_VERSION } from "../src/adapters/linkedin/constants.js";
import manifest from "../src/manifest.js";
import {
  ACME,
  GLOBEX,
  ONE_MINUTE_S,
  ORG_ACLS_URL,
  ORGS_URL,
  REACTIONS_URL,
  SIXTY_DAYS_S,
  TOKEN_URL,
  json,
  pluginConfig,
  tokenResponse,
  createWorld,
  revertToGrantBeforeFeedScopes,
  type FakePage,
  type World,
} from "./world.js";

const REDIRECT_PATH = `/api/plugins/${manifest.id}/api/oauth/callback`;
const NO_PAGE = "No LinkedIn Page is connected for this company. An operator must connect a Page first.";
/** The refusal of a DEK of 16 bytes. */
const BAD_DEK =
  "The Token Encryption Key (dekRef) cannot seal tokens: DEK must decode to exactly 32 bytes, got 16. " +
  "Correct dekRef in the plugin config, then connect again.";

let world: World;
let pages: PageConnections;

beforeEach(async () => {
  world = await createWorld();
  world.linkedin.scriptActions();
  pages = createPageConnections(world.ctx, world.linkedin.fetch);
});

afterEach(() => world.close());

async function startConnect(companyId = world.companyId): Promise<string> {
  const { authorizationUrl } = await pages.startConnect(companyId, "operator-1");
  return new URL(authorizationUrl).searchParams.get("state")!;
}

/** Finish connect with `redirect`, as LinkedIn sent it to the browser of `operatorId`. */
function finish(redirect: LinkedInRedirect, operatorId = "operator-1", companyId = world.companyId) {
  return pages.finishConnect(companyId, redirect, operatorId);
}

/** Answer connect with `fakePages`, start one connect and finish it. */
async function connectOutcome(fakePages: FakePage[], tokens: Record<string, unknown> = {}) {
  world.linkedin.scriptConnect(fakePages, tokens);
  return finish({ code: "code-1", state: await startConnect() });
}

/** Connect `fakePages` and return the connected Pages. A refusal fails the test. */
async function connect(fakePages: FakePage[], tokens: Record<string, unknown> = {}) {
  const outcome = await connectOutcome(fakePages, tokens);
  if (outcome.kind !== "connected") throw new Error(`Connect refused (${outcome.kind}): ${outcome.reason}`);
  return outcome.pages;
}

/** The stored pending connect of an OAuth state. */
function pendingConnect(state: string) {
  return world.harness.getState({ scopeKind: "company", scopeId: world.companyId, stateKey: `oauth:${state}` });
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
        "The default Page acme is not an organization id or an Organization URN. " +
          "An operator must correct defaultOrganizationUrn in the plugin config.",
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
          "or ask an operator to set the default Page (defaultOrganizationUrn) in the plugin config.",
      );
    });

    it("fails when no Page is connected", async () => {
      await expect(actAs()).rejects.toThrow(NO_PAGE);
    });

    it("fails when the named Page is not connected", async () => {
      await connect([ACME]);
      await expect(actAs("999")).rejects.toThrow(
        "No active connection for organization 999. An operator must connect the Page first.",
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
        "LinkedIn token for Page 111 expired and no refresh token is stored. An operator must connect the Page again.",
      );
      expect(await statusOf("111")).toBe("expired");
      await expect(actAs()).rejects.toThrow(NO_PAGE);
    });

    it("expires the Page connection when LinkedIn refuses the refresh token", async () => {
      await connect([ACME], { expires_in: ONE_MINUTE_S });
      world.linkedin.scriptRefresh(() => json({ error: "invalid_grant" }, 400));

      await expect(actAs()).rejects.toThrow(
        'Refreshing the LinkedIn token for Page 111 failed (LinkedIn token endpoint 400: {"error":"invalid_grant"}). ' +
          "An operator must connect the Page again.",
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
          "An operator must connect the Page again.",
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
          "An operator must examine both causes, then connect the Page again.",
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
        "Page 111 was connected without w_organization_social, which post needs. An operator must connect the Page again.",
      );
    });

    it("refuses an action without its scopes before it refreshes the token", async () => {
      await connect([ACME], { expires_in: ONE_MINUTE_S });
      await revertToGrantBeforeFeedScopes(world);

      await expect(pages.actAs(world.companyId, undefined, "react", async (page) => page)).rejects.toThrow(
        "Page 111 was connected without w_organization_social_feed, which react needs. " +
          "An operator must connect the Page again.",
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
  it("returns the authorization URL and stores the OAuth state for the operator", async () => {
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
    expect(pendingConnect(url.searchParams.get("state")!)).toEqual({
      createdAt: expect.any(Number),
      actorId: "operator-1",
    });
  });

  it("fails for a company with no plugin config", async () => {
    const other = await world.addCompany();
    await expect(pages.startConnect(other, "operator-1")).rejects.toThrow(
      "LinkedIn Page plugin is not configured for this company",
    );
  });

  it("refuses a DEK that cannot seal tokens and stores no OAuth state", async () => {
    world.secrets.dek = Buffer.alloc(16).toString("base64");
    const setState = vi.spyOn(world.ctx.state, "set");

    await expect(pages.startConnect(world.companyId, "operator-1")).rejects.toThrow(BAD_DEK);
    expect(setState).not.toHaveBeenCalled();
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
    expect(await connectOutcome([ACME, GLOBEX])).toEqual({
      kind: "connected",
      pages: [
        { organizationUrn: "urn:li:organization:111", organizationId: "111", name: "Acme", vanityName: "acme" },
        { organizationUrn: "urn:li:organization:222", organizationId: "222", name: "Globex", vanityName: "globex" },
      ],
    });
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

  it("renews an existing Page connection in place", async () => {
    await connect([ACME], { expires_in: ONE_MINUTE_S, refresh_token: undefined });
    await expect(actAs()).rejects.toThrow();
    expect(await statusOf("111")).toBe("expired");

    await connect([ACME], { access_token: "access-2" });

    expect((await pages.list(world.companyId)).map((p) => [p.organizationId, p.status])).toEqual([["111", "active"]]);
    await react();
    expect(reactionTokens()).toEqual(["Bearer access-2"]);
  });

  describe("the OAuth state", () => {
    const UNKNOWN_STATE = {
      kind: "invalid_state",
      reason: "The OAuth state is unknown, expired or used. Start connect again.",
    };

    it("is deleted after a successful connect", async () => {
      world.linkedin.scriptConnect([ACME]);
      const state = await startConnect();
      expect(await finish({ code: "code-1", state })).toHaveProperty("kind", "connected");
      expect(pendingConnect(state)).toBeFalsy();
    });

    it("refuses an unknown OAuth state", async () => {
      world.linkedin.scriptConnect([ACME]);
      expect(await finish({ code: "code-1", state: "nope" })).toEqual(UNKNOWN_STATE);
      expect(world.linkedin.tokenCalls()).toHaveLength(0);
    });

    it("refuses a second finish with one OAuth state", async () => {
      world.linkedin.scriptConnect([ACME]);
      const state = await startConnect();
      await finish({ code: "code-1", state });

      expect(await finish({ code: "code-1", state })).toEqual(UNKNOWN_STATE);
      expect(world.linkedin.tokenCalls()).toHaveLength(1);
    });

    it("is used up by a refused connect", async () => {
      world.linkedin.scriptConnect([]);
      const state = await startConnect();
      expect(await finish({ code: "code-1", state })).toHaveProperty("kind", "no_page");

      world.linkedin.scriptConnect([ACME]);
      expect(await finish({ code: "code-1", state })).toEqual(UNKNOWN_STATE);
      expect(world.linkedin.tokenCalls()).toHaveLength(1);
    });

    it("is used up by a refusal that LinkedIn sent", async () => {
      const state = await startConnect();
      await finish({ error: "user_cancelled_authorize", state });
      expect(pendingConnect(state)).toBeFalsy();
    });

    it("refuses and deletes an OAuth state that a different operator started", async () => {
      world.linkedin.scriptConnect([ACME]);
      const state = await startConnect();

      expect(await finish({ code: "code-1", state }, "operator-2")).toEqual({
        kind: "invalid_state",
        reason: "A different operator started this connect. Start connect again.",
      });
      expect(pendingConnect(state)).toBeFalsy();
      expect(world.linkedin.tokenCalls()).toHaveLength(0);
      expect(world.harness.logs).toContainEqual({
        level: "warn",
        message: "LinkedIn Page connect finished by a different operator",
        meta: { companyId: world.companyId, startedBy: "operator-1", finishedBy: "operator-2" },
      });
    });

    describe("age", () => {
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
        expect(await finish({ code: "code-1", state })).toHaveProperty("kind", "connected");
      });

      it("refuses and deletes an OAuth state older than ten minutes", async () => {
        world.linkedin.scriptConnect([ACME]);
        const state = await stateCreatedMinutesAgo(11);

        expect(await finish({ code: "code-1", state })).toEqual(UNKNOWN_STATE);
        expect(world.linkedin.tokenCalls()).toHaveLength(0);
        expect(pendingConnect(state)).toBeFalsy();
      });
    });
  });

  describe("the redirect", () => {
    it("reports a refusal that LinkedIn sent", async () => {
      const state = await startConnect();
      expect(
        await finish({ error: "user_cancelled_login", error_description: "The user cancelled", state }),
      ).toEqual({ kind: "declined", reason: "user_cancelled_login: The user cancelled" });
      expect(world.linkedin.tokenCalls()).toHaveLength(0);
    });

    it("reports a refusal without a description", async () => {
      expect(await finish({ error: "user_cancelled_authorize" })).toEqual({
        kind: "declined",
        reason: "user_cancelled_authorize",
      });
    });

    it.each([
      ["no code", { state: "state-1" }],
      ["no state", { code: "code-1" }],
      ["a repeated code", { code: ["code-1", "code-2"], state: "state-1" }],
    ])("refuses a redirect with %s", async (_case, redirect) => {
      expect(await finish(redirect)).toEqual({
        kind: "incomplete_redirect",
        reason: "LinkedIn did not return an authorization code and an OAuth state. Start connect again.",
      });
      expect(world.linkedin.tokenCalls()).toHaveLength(0);
    });
  });

  describe("refusals", () => {
    it("refuses an authorization code that LinkedIn refuses", async () => {
      world.linkedin.scriptConnect([ACME]);
      world.linkedin.on("POST", TOKEN_URL, () => json({ error: "invalid_grant" }, 400));

      expect(await finish({ code: "code-1", state: await startConnect() })).toEqual({
        kind: "code_refused",
        reason:
          'LinkedIn refused the authorization code (LinkedIn token endpoint 400: {"error":"invalid_grant"}). ' +
          "Start connect again.",
      });
    });

    it("refuses a grant without the organization feed scope", async () => {
      expect(
        await connectOutcome([ACME], { scope: "r_organization_social,w_organization_social,rw_organization_admin" }),
      ).toEqual({
        kind: "grant_refused",
        reason: expect.stringMatching(/^LinkedIn did not grant w_organization_social_feed\. /),
      });
      expect(await pages.list(world.companyId)).toEqual([]);
    });

    it("refuses a grant that names no scopes", async () => {
      expect(await connectOutcome([ACME], { scope: undefined })).toEqual({
        kind: "grant_refused",
        reason: expect.stringMatching(/^LinkedIn did not report the granted scopes/),
      });
      expect(await pages.list(world.companyId)).toEqual([]);
    });

    it("refuses a member who administers no Page", async () => {
      expect(await connectOutcome([])).toEqual({
        kind: "no_page",
        reason:
          "The authorizing member does not administer any LinkedIn Page. " +
          "Grant them an ADMINISTRATOR role on the Page and reconnect.",
      });
    });
  });

  describe("faults", () => {
    it.each([
      ["a LinkedIn outage", () => json({ message: "Service Unavailable" }, 503)],
      [
        "a network error",
        () => {
          throw new TypeError("fetch failed");
        },
      ],
    ])("reports %s at the code exchange as a LinkedIn failure and logs it", async (_cause, respond) => {
      world.linkedin.scriptConnect([ACME]);
      world.linkedin.on("POST", TOKEN_URL, respond);

      const outcome = await finish({ code: "code-1", state: await startConnect() });

      expect(outcome).toEqual({
        kind: "linkedin_failed",
        reason: expect.stringMatching(/^LinkedIn did not exchange the authorization code \(.+\)\.$/s),
      });
      expect(world.harness.logs).toContainEqual({
        level: "error",
        message: "LinkedIn Page connect failed",
        meta: { companyId: world.companyId, ...outcome },
      });
      expect(await pages.list(world.companyId)).toEqual([]);
    });

    it("reports a client that LinkedIn refuses as a plugin failure that names the Client Secret", async () => {
      world.linkedin.scriptConnect([ACME]);
      world.linkedin.on("POST", TOKEN_URL, () => json({ error: "invalid_client" }, 401));

      const outcome = await finish({ code: "code-1", state: await startConnect() });

      expect(outcome).toEqual({
        kind: "plugin_failed",
        reason:
          'LinkedIn refused the client credentials of the plugin (LinkedIn token endpoint 401: {"error":"invalid_client"} — ' +
          "client_id is valid if authorization succeeded, so this points at the stored Client Secret: " +
          "confirm it matches the app's current Primary Client Secret.). " +
          "Correct clientSecretRef in the plugin config, then connect again.",
      });
      expect(world.harness.logs).toContainEqual({
        level: "error",
        message: "LinkedIn Page connect failed",
        meta: { companyId: world.companyId, ...outcome },
      });
      expect(await pages.list(world.companyId)).toEqual([]);
    });

    it("reports a failed Page list as a LinkedIn failure", async () => {
      world.linkedin.scriptConnect([ACME]);
      world.linkedin.on("GET", ORG_ACLS_URL, () => json({ message: "Internal Server Error" }, 500));

      expect(await finish({ code: "code-1", state: await startConnect() })).toEqual({
        kind: "linkedin_failed",
        reason:
          "LinkedIn did not list the Pages that the authorizing member administers " +
          '(organizationAcls 500: {"message":"Internal Server Error"}).',
      });
    });

    it("names the developer action when LinkedIn retired the API version", async () => {
      world.linkedin.scriptConnect([ACME]);
      world.linkedin.on("GET", ORG_ACLS_URL, () => json({ code: "NONEXISTENT_VERSION" }, 426));

      expect(await finish({ code: "code-1", state: await startConnect() })).toEqual({
        kind: "linkedin_failed",
        reason:
          `LinkedIn retired API version ${LINKEDIN_VERSION} (organizationAcls 426: {"code":"NONEXISTENT_VERSION"}). ` +
          "Update LINKEDIN_VERSION and release the plugin. A reconnect does not help.",
      });
    });

    it("refuses a DEK that changed after start before LinkedIn spends the code", async () => {
      world.linkedin.scriptConnect([ACME]);
      const state = await startConnect();
      world.secrets.dek = Buffer.alloc(16).toString("base64");

      expect(await finish({ code: "code-1", state })).toEqual({ kind: "plugin_failed", reason: BAD_DEK });
      expect(world.linkedin.tokenCalls()).toHaveLength(0);
    });

    it("reports a company whose plugin config is gone as a plugin failure", async () => {
      const state = await startConnect();
      world.configs.delete(world.companyId);

      expect(await finish({ code: "code-1", state })).toEqual({
        kind: "plugin_failed",
        reason: "LinkedIn Page plugin is not configured for this company",
      });
    });

    it("reports a database failure without the database error", async () => {
      // A company with a config but no company row: the insert breaks its foreign key.
      const ghost = randomUUID();
      world.configs.set(ghost, pluginConfig());
      world.linkedin.scriptConnect([ACME]);

      expect(await finish({ code: "code-1", state: await startConnect(ghost) }, "operator-1", ghost)).toEqual({
        kind: "plugin_failed",
        reason: "Connected to LinkedIn but could not store the connection. See the plugin logs for the database error.",
      });
      expect(world.harness.logs).toContainEqual({
        level: "error",
        message: "failed to store LinkedIn Page connection",
        meta: { companyId: ghost, pageCount: 1, error: expect.stringContaining("foreign key") },
      });
    });
  });

  describe("Page names", () => {
    it.each([
      ["fails", () => json({ message: "Internal Server Error" }, 500)],
      [
        "throws",
        () => {
          throw new TypeError("fetch failed");
        },
      ],
      ["returns no name", () => json({ results: { "111": {} } })],
    ])("connects a Page without a name when the names call %s", async (_case, respond) => {
      world.linkedin.scriptConnect([ACME]);
      world.linkedin.on("GET", ORGS_URL, respond);

      expect(await finish({ code: "code-1", state: await startConnect() })).toEqual({
        kind: "connected",
        pages: [{ organizationUrn: "urn:li:organization:111", organizationId: "111", name: null, vanityName: null }],
      });
      expect(await pages.list(world.companyId)).toEqual([
        expect.objectContaining({ organizationId: "111", displayName: "urn:li:organization:111", status: "active" }),
      ]);
    });
  });
});

describe("disconnect", () => {
  it("revokes the Page connection and clears its tokens", async () => {
    await connect([ACME, GLOBEX]);

    expect(await pages.disconnect(world.companyId, "222")).toBe(true);

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

  it("revokes a revoked Page connection again", async () => {
    await connect([ACME]);
    await pages.disconnect(world.companyId, "111");
    expect(await pages.disconnect(world.companyId, "111")).toBe(true);
  });

  it("reports a Page that the company never connected", async () => {
    await connect([ACME]);
    expect(await pages.disconnect(world.companyId, "222")).toBe(false);
    expect(await statusOf("111")).toBe("active");
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
