import type { JsonSchema, PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

/**
 * A Paperclip secret reference.
 *
 * The host marks these paths by `format: "secret-ref"` (which it collects
 * regardless of declared type) and then requires the stored value to be a
 * binding object — a bare UUID string is rejected as a legacy form. So the
 * declared type must be `object`, not `string`.
 */
function secretRef(title: string, description: string): JsonSchema {
  return {
    type: "object",
    format: "secret-ref",
    title,
    description,
    required: ["type", "secretId"],
    properties: {
      type: { type: "string", enum: ["secret_ref"] },
      secretId: { type: "string", description: "UUID of the Paperclip company secret." },
      version: { type: "string" },
    },
  };
}

/**
 * The acting Page of a tool call. The text states the rule of
 * `PageConnections.actAs`: the named Page, else the default Page, else the
 * only active Page.
 */
const organizationIdParam: JsonSchema = {
  type: "string",
  description:
    "Numeric organization id of the Page to act as, from linkedin-page-list. If you omit it, " +
    "the tool uses the default Page, else the only active Page. If several Pages are active " +
    "and no default Page is set, the call fails.",
};

const instanceConfigSchema: JsonSchema = {
  type: "object",
  required: ["dekRef", "redirectBaseUrl", "clientIdRef", "clientSecretRef"],
  properties: {
    dekRef: secretRef(
      "Token Encryption Key (32 bytes, base64)",
      "Paperclip secret holding 32 random bytes, base64-encoded. Envelope-encrypts stored OAuth tokens.",
    ),
    redirectBaseUrl: {
      type: "string",
      title: "Public base URL",
      description:
        "Public origin of this Paperclip instance, e.g. https://paperclip.example.com. Used to build the OAuth redirect URI.",
    },
    clientIdRef: secretRef(
      "LinkedIn Client ID",
      "Secret holding the Client ID of the LinkedIn app approved for Community Management.",
    ),
    clientSecretRef: secretRef(
      "LinkedIn Primary Client Secret",
      "Secret holding the Primary Client Secret for the same LinkedIn app.",
    ),
    defaultOrganizationUrn: {
      type: "string",
      title: "Default Page (organization URN)",
      description:
        "Optional. urn:li:organization:{id} used when an agent calls a tool without naming a page. Populated by the settings page once a Page is connected.",
    },
  },
};

const manifest: PaperclipPluginManifestV1 = {
  id: "sirantd.linkedin-org",
  apiVersion: 1,
  version: "0.1.0",
  displayName: "LinkedIn Page",
  description:
    "Manage a company LinkedIn Page from Paperclip. Connects Pages the authorizing member administers (OAuth, Community Management API) and lets agents publish, react and comment as the organization.",
  author: "sirantd",
  categories: ["connector", "automation"],

  capabilities: [
    "companies.read",
    "activity.log.write",
    "activity.read",
    "plugin.state.read",
    "plugin.state.write",
    "database.namespace.migrate",
    "database.namespace.read",
    "database.namespace.write",
    "http.outbound",
    "secrets.read-ref",
    "agent.tools.register",
    "api.routes.register",
    "instance.settings.register",
  ],

  entrypoints: {
    worker: "./dist/worker.js",
  },

  database: {
    namespaceSlug: "linkedin_org",
    migrationsDir: "migrations",
    coreReadTables: ["companies"],
  },

  instanceConfigSchema,

  tools: [
    {
      name: "linkedin-page-list",
      displayName: "List LinkedIn Pages",
      description:
        "List the company LinkedIn Pages connected to Paperclip that agents can publish as. " +
        "Call this first to find the organizationId for the other linkedin-page tools.",
      parametersSchema: { type: "object", properties: {} },
    },
    {
      name: "linkedin-page-post",
      displayName: "Post as LinkedIn Page",
      description:
        "Publish a post authored by the company LinkedIn Page. The post goes live immediately " +
        "and publicly — do not call this to draft or preview.",
      parametersSchema: {
        type: "object",
        required: ["text"],
        properties: {
          text: { type: "string", description: "Post body. Plain text; LinkedIn renders line breaks." },
          organizationId: organizationIdParam,
          visibility: { type: "string", enum: ["PUBLIC", "LOGGED_IN"], default: "PUBLIC" },
        },
      },
    },
    {
      name: "linkedin-page-react",
      displayName: "React as LinkedIn Page",
      description: "React to a LinkedIn post as the company Page.",
      parametersSchema: {
        type: "object",
        required: ["postUrn"],
        properties: {
          postUrn: {
            type: "string",
            description: "urn:li:activity:… / urn:li:share:… / urn:li:ugcPost:…",
          },
          organizationId: organizationIdParam,
          reactionType: {
            type: "string",
            enum: ["LIKE", "PRAISE", "EMPATHY", "INTEREST", "APPRECIATION"],
            default: "LIKE",
          },
        },
      },
    },
    {
      name: "linkedin-page-comment",
      displayName: "Comment as LinkedIn Page",
      description: "Post a top-level text comment on a LinkedIn post as the company Page.",
      parametersSchema: {
        type: "object",
        required: ["postUrn", "text"],
        properties: {
          postUrn: { type: "string" },
          text: { type: "string" },
          organizationId: organizationIdParam,
        },
      },
    },
  ],

  apiRoutes: [
    {
      routeKey: "list-pages",
      method: "GET",
      path: "/pages",
      auth: "board",
      capability: "api.routes.register",
      companyResolution: { from: "query", key: "companyId" },
    },
    {
      routeKey: "oauth-start",
      method: "POST",
      path: "/oauth/start",
      auth: "board",
      capability: "api.routes.register",
      companyResolution: { from: "body", key: "companyId" },
    },
    {
      routeKey: "oauth-complete",
      method: "POST",
      path: "/oauth/complete",
      auth: "board",
      capability: "api.routes.register",
      companyResolution: { from: "body", key: "companyId" },
    },
    {
      // LinkedIn redirects the operator's browser here with ?code&state, so this
      // must be a GET. companyId rides in the registered redirect URI because
      // company resolution only reads body/query and LinkedIn echoes neither.
      routeKey: "oauth-callback",
      method: "GET",
      path: "/oauth/callback",
      auth: "board",
      capability: "api.routes.register",
      companyResolution: { from: "query", key: "companyId" },
    },
    {
      routeKey: "disconnect",
      method: "POST",
      path: "/pages/:organizationId/disconnect",
      auth: "board",
      capability: "api.routes.register",
      companyResolution: { from: "body", key: "companyId" },
    },
  ],
};

export default manifest;
