import { beforeEach, describe, expect, it } from "vitest";
import { createPageConnections, type PageConnections } from "../src/page-connections.js";
import { openToken } from "../src/crypto.js";
import { LINKEDIN_ORG_SCOPES } from "../src/adapters/linkedin/constants.js";
import {
  ACME,
  GLOBEX,
  ONE_MINUTE_S,
  SIXTY_DAYS_S,
  json,
  pluginConfig,
  tokenResponse,
  createWorld,
  type FakePage,
  type World,
} from "./world.js";

const REDIRECT_PATH = "/api/plugins/sirantd.linkedin-org/api/oauth/callback";
const NO_PAGE = "No LinkedIn Page is connected for this company. Connect one in Settings first.";

let world: World;
let pages: PageConnections;

beforeEach(async () => {
  world = await createWorld();
  pages = createPageConnections(world.ctx);
});

async function startConnect(): Promise<string> {
  const { authorizationUrl } = await pages.startConnect(world.companyId, "operator-1");
  return new URL(authorizationUrl).searchParams.get("state")!;
}

async function connect(fakePages: FakePage[], tokens: Record<string, unknown> = {}) {
  world.linkedin.scriptConnect(fakePages, tokens);
  return pages.finishConnect(world.companyId, "code-1", await startConnect(), "operator-1");
}

function actAs(organizationId?: string) {
  return pages.actAs(world.companyId, organizationId);
}

async function statusOf(organizationId: string) {
  return (await pages.list(world.companyId)).find((p) => p.organizationId === organizationId)?.status;
}

describe("actAs", () => {
  it("returns the acting Page with the stored token while it is valid", async () => {
    await connect([ACME]);

    expect(await actAs()).toEqual({
      organizationId: "111",
      organizationUrn: "urn:li:organization:111",
      displayName: "Acme",
      accessToken: "access-1",
    });
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

    it("uses the default Page when the call names none", async () => {
      world.configs.set(world.companyId, pluginConfig({ defaultOrganizationUrn: "urn:li:organization:222" }));
      await connect([ACME, GLOBEX]);
      expect((await actAs()).organizationId).toBe("222");
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

      expect((await actAs()).accessToken).toBe("access-2");
      expect((await actAs()).accessToken).toBe("access-2");

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

    it("expires the Page connection when no refresh token is stored", async () => {
      await connect([ACME], { expires_in: ONE_MINUTE_S, refresh_token: undefined });

      await expect(actAs()).rejects.toThrow(
        "LinkedIn token for Page 111 expired and no refresh token is stored. Reconnect the Page in Settings.",
      );
      expect(await statusOf("111")).toBe("expired");
      await expect(actAs()).rejects.toThrow(NO_PAGE);
    });

    it("expires the Page connection when the refresh fails", async () => {
      await connect([ACME], { expires_in: ONE_MINUTE_S });
      world.linkedin.scriptRefresh(() => json({ error: "invalid_grant" }, 400));

      await expect(actAs()).rejects.toThrow(
        'Refreshing the LinkedIn token for Page 111 failed (LinkedIn token endpoint 400: {"error":"invalid_grant"}). ' +
          "Reconnect the Page in Settings.",
      );
      expect(await statusOf("111")).toBe("expired");
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

    expect(scopes).toEqual(LINKEDIN_ORG_SCOPES);
    const url = new URL(authorizationUrl);
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

  it("fails for a company with no plugin config", async () => {
    const other = await world.addCompany();
    await expect(pages.startConnect(other, "operator-1")).rejects.toThrow(
      "LinkedIn Page plugin is not configured for this company",
    );
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
    expect((await actAs()).accessToken).toBe("access-2");
  });

  it("rejects an unknown OAuth state", async () => {
    await expect(pages.finishConnect(world.companyId, "code-1", "nope", "operator-1")).rejects.toThrow(
      "Unknown or expired OAuth state",
    );
  });

  it("rejects a grant without the organization feed scope", async () => {
    await expect(
      connect([ACME], { scope: "r_organization_social,w_organization_social,rw_organization_admin" }),
    ).rejects.toThrow(/^LinkedIn did not grant w_organization_social_feed\. /);
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
});

describe("configuration", () => {
  it("fails for a company with no plugin config", async () => {
    const other = await world.addCompany();
    await expect(pages.actAs(other)).rejects.toThrow("LinkedIn Page plugin is not configured for this company");
  });
});
