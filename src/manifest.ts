import type {
  JsonSchema,
  PaperclipPluginManifestV1,
  PluginApiRouteDeclaration,
  PluginToolDeclaration,
} from "@paperclipai/plugin-sdk";
import { ACCEPTED_FILES, MAX_MEDIA_BYTES } from "./adapters/linkedin/media.js";
import type { FromSchema } from "./json-schema.js";

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
const organizationIdParam = {
  type: "string",
  description:
    "Organization id (12345) or Organization URN (urn:li:organization:12345) of the Page to act as, " +
    "from linkedin-page-list. If you omit it, " +
    "the tool uses the default Page, else the only active Page. If several Pages are active " +
    "and no default Page is set, the call fails.",
} as const satisfies JsonSchema;

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
    defaultOrganization: {
      type: "string",
      title: "Default Page (organization id or URN)",
      description:
        "Optional. The organization id or urn:li:organization:{id}, used when an agent calls a tool without naming a Page. Connect does not set it. Set it in the plugin config after you connect the Page.",
    },
    // Kept so that a saved config stays valid.
    defaultOrganizationUrn: {
      type: "string",
      title: "Default Page (deprecated)",
      description:
        "Deprecated. Use defaultOrganization. This key applies only when defaultOrganization is not set.",
    },
  },
};

const MIB = 1024 * 1024;

/**
 * The agent tools. The literal types let the worker take each tool's
 * parameter type from its `parametersSchema`.
 */
const tools = [
  {
    name: "linkedin-page-list",
    displayName: "List LinkedIn Pages",
    description:
      "List the company LinkedIn Pages connected to Paperclip that agents can publish as. " +
      "Call this first to find the organizationId for the other linkedin-page tools.",
    parametersSchema: { type: "object", properties: {} },
  },
  {
    name: "linkedin-page-upload",
    displayName: "Upload a file for a LinkedIn Page post",
    description:
      "Upload one Paperclip issue attachment to LinkedIn for a later post as the company Page. " +
      `The file must be ${ACCEPTED_FILES}, of ${MAX_MEDIA_BYTES / MIB} MiB or less. Nothing is published. ` +
      "Returns the mediaUrn and its processing status. Pass the mediaUrn to linkedin-page-post " +
      "with the same organizationId.",
    parametersSchema: {
      type: "object",
      required: ["attachmentId"],
      properties: {
        attachmentId: { type: "string", description: "Id of an attachment on a Paperclip issue of this company." },
        organizationId: organizationIdParam,
      },
    },
  },
  {
    name: "linkedin-page-post",
    displayName: "Post as LinkedIn Page",
    description:
      "Publish a post authored by the company LinkedIn Page, with text and optionally one image or " +
      "document from linkedin-page-upload. The post goes live immediately and publicly — do not call " +
      "this to draft or preview.",
    parametersSchema: {
      type: "object",
      required: ["text"],
      properties: {
        text: { type: "string", description: "Post body. Plain text; LinkedIn renders line breaks." },
        organizationId: organizationIdParam,
        visibility: { type: "string", enum: ["PUBLIC", "LOGGED_IN"], default: "PUBLIC" },
        mediaUrn: {
          type: "string",
          description:
            "Optional. The urn:li:image:… or urn:li:document:… that linkedin-page-upload returned for the " +
            "same Page. If LinkedIn is still processing the file, the call fails and publishes nothing; " +
            "call again later.",
        },
        title: {
          type: "string",
          description: "Title of the document. Required with a urn:li:document mediaUrn.",
        },
        altText: {
          type: "string",
          description: "Optional alternative text that describes the image. Maximum 4,086 characters.",
        },
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
] as const satisfies readonly PluginToolDeclaration[];

/** The API routes. The worker keys its route table by these `routeKey` values. */
const apiRoutes = [
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
] as const satisfies readonly PluginApiRouteDeclaration[];

type ToolDeclaration = (typeof tools)[number];

/** The name of an agent tool in the manifest. */
export type ToolName = ToolDeclaration["name"];

/** The parameters that the manifest declares for the agent tool `N`. */
export type ToolParams<N extends ToolName> = FromSchema<Extract<ToolDeclaration, { name: N }>["parametersSchema"]>;

/** The key of an API route in the manifest. */
export type RouteKey = (typeof apiRoutes)[number]["routeKey"];

const manifest = {
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
    "plugin.state.read",
    "plugin.state.write",
    "database.namespace.migrate",
    "database.namespace.read",
    "database.namespace.write",
    "http.outbound",
    "issue.attachments.read",
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

  // The SDK types take mutable arrays. The entries stay the same objects.
  tools: [...tools],
  apiRoutes: [...apiRoutes],
} satisfies PaperclipPluginManifestV1;

export default manifest;
