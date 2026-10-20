import { readFileSync } from "node:fs";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { vi } from "vitest";
import { createTestHarness, type TestHarness } from "@paperclipai/plugin-sdk/testing";
import type { PluginApiRequestInput, PluginContext, PluginHttpClient } from "@paperclipai/plugin-sdk";
import manifest from "../src/manifest.js";
import { REQUESTED_SCOPES } from "../src/adapters/linkedin/scopes.js";

/** The schema the migration names directly; see migrations/0001_pages.sql. */
const NAMESPACE = "plugin_linkedin_org_670c26f221";
const MIGRATION = readFileSync(new URL("../migrations/0001_pages.sql", import.meta.url), "utf8");

export const TOKEN_URL = "https://www.linkedin.com/oauth/v2/accessToken";
export const ORG_ACLS_URL = "https://api.linkedin.com/rest/organizationAcls";
export const ORGS_URL = "https://api.linkedin.com/rest/organizations";
export const POSTS_URL = "https://api.linkedin.com/rest/posts";
export const REACTIONS_URL = "https://api.linkedin.com/rest/reactions";
export const COMMENTS_URL = "https://api.linkedin.com/rest/socialActions";
export const IMAGES_URL = "https://api.linkedin.com/rest/images";
export const DOCUMENTS_URL = "https://api.linkedin.com/rest/documents";
export const UPLOAD_URL = "https://www.linkedin.com/dms-uploads/";

/** LinkedIn tokens live 60 days; one minute falls inside the refresh skew. */
export const SIXTY_DAYS_S = 60 * 24 * 60 * 60;
export const ONE_MINUTE_S = 60;

export interface FakePage {
  id: string;
  name: string | null;
}

export const ACME: FakePage = { id: "111", name: "Acme" };
export const GLOBEX: FakePage = { id: "222", name: "Globex" };

export interface RecordedRequest {
  method: string;
  url: URL;
  headers: Record<string, string>;
  /** The body text, or "" for a body that is not a string. */
  body: string;
  /** The body bytes, or null for a body that is a string or absent. */
  bytes: Uint8Array | null;
}

type Responder = (req: RecordedRequest) => Response | Promise<Response>;

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export function tokenResponse(overrides: Record<string, unknown> = {}): Response {
  return json({
    access_token: "access-1",
    expires_in: SIXTY_DAYS_S,
    refresh_token: "refresh-1",
    refresh_token_expires_in: 365 * 24 * 60 * 60,
    scope: REQUESTED_SCOPES.join(","),
    ...overrides,
  });
}

/**
 * Scripted stand-in for LinkedIn behind ctx.http. A request with no matching
 * route fails the test instead of reaching the network.
 */
export class FakeLinkedIn {
  readonly requests: RecordedRequest[] = [];
  private readonly routes: Array<{ method: string; prefix: string; respond: Responder }> = [];

  /** Later registrations win, so a test can override a default route. */
  on(method: string, urlPrefix: string, respond: Responder): void {
    this.routes.unshift({ method, prefix: urlPrefix, respond });
  }

  requestsTo(urlPrefix: string): RecordedRequest[] {
    return this.requests.filter((r) => r.url.toString().startsWith(urlPrefix));
  }

  /** Form fields of each token endpoint call, oldest first. */
  tokenCalls(): URLSearchParams[] {
    return this.requestsTo(TOKEN_URL).map((r) => new URLSearchParams(r.body));
  }

  readonly fetch = async (url: string, init: RequestInit = {}): Promise<Response> => {
    const req: RecordedRequest = {
      method: init.method ?? "GET",
      url: new URL(url),
      headers: { ...(init.headers as Record<string, string> | undefined) },
      body: typeof init.body === "string" ? init.body : "",
      bytes: init.body instanceof Uint8Array ? new Uint8Array(init.body) : null,
    };
    this.requests.push(req);
    const route = this.routes.find((r) => r.method === req.method && url.startsWith(r.prefix));
    if (!route) throw new Error(`FakeLinkedIn: no route for ${req.method} ${url}`);
    return route.respond(req);
  };

  /**
   * Answer the connect flow: the code exchange, the Page ACL lookup and the
   * name lookup. A Page with a null name is left out of the name lookup.
   */
  scriptConnect(pages: FakePage[], tokens: Record<string, unknown> = {}): void {
    this.on("POST", TOKEN_URL, (req) =>
      new URLSearchParams(req.body).get("grant_type") === "authorization_code"
        ? tokenResponse(tokens)
        : json({ error: "unexpected_grant" }, 400),
    );
    this.on("GET", ORG_ACLS_URL, () =>
      json({ elements: pages.map((p) => ({ organization: `urn:li:organization:${p.id}` })) }),
    );
    this.on("GET", ORGS_URL, () =>
      json({
        results: Object.fromEntries(
          pages
            .filter((p) => p.name !== null)
            .map((p) => [p.id, { localizedName: p.name, vanityName: p.name!.toLowerCase() }]),
        ),
      }),
    );
  }

  /** Answer refresh_token grants; the code exchange route stays as scripted. */
  scriptRefresh(respond: Responder): void {
    const previous = this.routes.find((r) => r.method === "POST" && r.prefix === TOKEN_URL);
    this.on("POST", TOKEN_URL, (req) =>
      new URLSearchParams(req.body).get("grant_type") === "refresh_token"
        ? respond(req)
        : previous
          ? previous.respond(req)
          : json({ error: "unexpected_grant" }, 400),
    );
  }

  scriptActions(postUrn = "urn:li:share:9"): void {
    this.on("POST", POSTS_URL, () => new Response(null, { status: 201, headers: { "x-restli-id": postUrn } }));
    this.on("POST", REACTIONS_URL, () => new Response(null, { status: 201 }));
    this.on("POST", COMMENTS_URL, () => json({}, 201));
  }

  /**
   * Answer the upload flow of both media APIs and the status read. Each
   * upload start returns the URN `urn:li:{kind}:1`; each status read reports
   * `status` and `owner`.
   */
  scriptMedia(status = "AVAILABLE", owner = `urn:li:organization:${ACME.id}`): void {
    for (const [kind, url] of [["image", IMAGES_URL], ["document", DOCUMENTS_URL]] as const) {
      this.on("POST", `${url}?action=initializeUpload`, () =>
        json({
          value: {
            uploadUrlExpiresAt: 1650567510704,
            uploadUrl: `${UPLOAD_URL}${kind}-1`,
            [kind]: `urn:li:${kind}:1`,
          },
        }),
      );
      this.on("GET", `${url}/`, () => json({ owner, id: `urn:li:${kind}:1`, status }));
    }
    this.on("PUT", UPLOAD_URL, () => new Response(null, { status: 201 }));
  }
}

/** ctx.http in front of `linkedin`. As the SDK client does, it sends a body that is not a string as String(body). */
export function hostHttp(linkedin: FakeLinkedIn): PluginHttpClient {
  return {
    fetch: (url: string, init: RequestInit = {}) =>
      linkedin.fetch(url, init.body == null || typeof init.body === "string" ? init : { ...init, body: String(init.body) }),
  };
}

/**
 * Put an attachment with `bytes` on a new issue of `companyId`, as the host
 * stores it, and return the attachment.
 */
export function seedAttachment(
  world: World,
  file: { contentType: string; bytes: Uint8Array; originalFilename?: string | null; byteSize?: number },
  companyId = world.companyId,
) {
  const now = new Date();
  const attachment = {
    id: randomUUID(),
    companyId,
    issueId: randomUUID(),
    issueCommentId: null,
    assetId: randomUUID(),
    provider: "local",
    objectKey: "objects/1",
    contentType: file.contentType,
    byteSize: file.byteSize ?? file.bytes.byteLength,
    sha256: createHash("sha256").update(file.bytes).digest("hex"),
    originalFilename: file.originalFilename === undefined ? "file.bin" : file.originalFilename,
    createdByAgentId: null,
    createdByUserId: null,
    createdAt: now,
    updatedAt: now,
    contentPath: "/content",
  };
  world.harness.seed({
    issueAttachments: [{ ...attachment, contentBase64: Buffer.from(file.bytes).toString("base64") }],
  });
  return attachment;
}

export function pluginConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    dekRef: { type: "secret_ref", secretId: "dek" },
    redirectBaseUrl: "https://paperclip.example.com/",
    clientIdRef: { type: "secret_ref", secretId: "client-id" },
    clientSecretRef: { type: "secret_ref", secretId: "client-secret" },
    ...overrides,
  };
}

export interface World {
  harness: TestHarness;
  ctx: PluginContext;
  linkedin: FakeLinkedIn;
  companyId: string;
  /** Plugin config for each company. A company with no entry is unconfigured. */
  configs: Map<string, Record<string, unknown>>;
  /** Secret values by secretId. */
  secrets: Record<string, string>;
  dek: string;
  /** Raw SQL against the plugin schema, for at-rest setup and assertions only. */
  sql<T = Record<string, unknown>>(statement: string, params?: unknown[]): Promise<T[]>;
  /** Add a company row so page_connections can reference it. */
  addCompany(): Promise<string>;
  /** Free the PGLite clone. Each clone holds hundreds of MB until it is closed. */
  close(): Promise<void>;
}

let template: Promise<PGlite> | undefined;

/** Migrate once per test file; each world clones the result. */
function migratedTemplate(): Promise<PGlite> {
  template ??= (async () => {
    const pg = new PGlite();
    await pg.exec(`create table public.companies (id uuid primary key); create schema ${NAMESPACE};`);
    await pg.exec(MIGRATION);
    return pg;
  })();
  return template;
}

/**
 * A fresh plugin context on the SDK harness, with Postgres (PGLite running the
 * real migration), LinkedIn, secrets and per-company config replaced.
 */
export async function createWorld(): Promise<World> {
  const pg = await (await migratedTemplate()).clone();

  const harness = createTestHarness({ manifest });
  const linkedin = new FakeLinkedIn();
  const dek = randomBytes(32).toString("base64");
  const secrets: Record<string, string> = { dek, "client-id": "client-id", "client-secret": "client-secret" };
  const configs = new Map<string, Record<string, unknown>>();

  const sql = async <T>(statement: string, params?: unknown[]): Promise<T[]> =>
    (await pg.query<T>(statement, params)).rows;
  const addCompany = async (): Promise<string> => {
    const id = randomUUID();
    await pg.query(`insert into public.companies (id) values ($1)`, [id]);
    return id;
  };

  Object.assign(harness.ctx, {
    db: {
      namespace: NAMESPACE,
      query: sql,
      async execute(statement: string, params?: unknown[]) {
        const result = await pg.query(statement, params);
        return { rowCount: result.affectedRows ?? 0 };
      },
    },
    http: hostHttp(linkedin),
    secrets: {
      async resolve(ref: { secretId: string }) {
        const value = secrets[ref.secretId];
        if (value === undefined) throw new Error(`unknown secret ${ref.secretId}`);
        return value;
      },
    },
    config: {
      async get(companyId: string) {
        return configs.get(companyId) ?? null;
      },
    },
  });

  const companyId = await addCompany();
  configs.set(companyId, pluginConfig());

  // File uploads use the Node fetch, not ctx.http. The stub comes after the
  // PGLite load; vitest.config.ts restores the real fetch after each test.
  vi.stubGlobal("fetch", linkedin.fetch);

  const close = () => pg.close();

  return { harness, ctx: harness.ctx, linkedin, companyId, configs, secrets, dek, sql, addCompany, close };
}

/**
 * Give every Page connection the grant of a connect from before the feed
 * scopes. Connect refuses that grant now, so only stored rows can hold it.
 */
export async function revertToGrantBeforeFeedScopes(world: World): Promise<void> {
  await world.sql(
    `update ${world.ctx.db.namespace}.page_connections
        set scopes = '{r_organization_social,w_organization_social,rw_organization_admin}'`,
  );
}

export function routeInput(
  routeKey: string,
  companyId: string,
  input: Partial<Pick<PluginApiRequestInput, "query" | "body" | "params">> = {},
): PluginApiRequestInput {
  return {
    routeKey,
    method: "GET",
    path: "",
    params: {},
    query: {},
    body: undefined,
    actor: { actorType: "user", actorId: "operator-1" },
    companyId,
    headers: {},
    ...input,
  };
}

/** What the host sends on the wire: route bodies and tool results go through JSON. */
export function wire<T>(value: T): unknown {
  return JSON.parse(JSON.stringify(value));
}
