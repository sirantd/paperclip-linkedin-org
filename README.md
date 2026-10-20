# LinkedIn Page plugin for Paperclip

Manage a company LinkedIn Page from Paperclip. Connects the Pages the
authorizing member administers and lets agents publish, react and comment
**as the organization**.

Complements `@blaze283/social-agent-plugin` (which posts as *members*); the two
run side by side and do not share state.

## Requirements

- A LinkedIn app approved for the **Community Management API** product.
  Organization scopes are not granted to unapproved apps — LinkedIn silently
  drops them rather than failing authorization, so the plugin checks the
  granted scope list at connect time and fails loudly instead.
- The authorizing member must hold an **ADMINISTRATOR** role on the Page.

## Scopes

Connect requests each scope in this table. It refuses a grant that lacks a
scope that any step needs. An agent tool refuses to act as a Page whose connection lacks a
scope that the action needs, and tells the operator to reconnect the Page.

| Scope | Needed for |
|---|---|
| `r_organization_social` | none |
| `w_organization_social` | post, react, comment, upload |
| `r_organization_social_feed` | none |
| `w_organization_social_feed` | react, comment |
| `rw_organization_admin` | connect |

Connect uses `rw_organization_admin` to list the Pages that the authorizing
member administers. No step needs the two `r_` scopes. The live test of
2026-09-29 added them together with the feed scopes, so it does not show that
react and comment work without them.

No `openid`/`profile`/`email`: those belong to Sign In with LinkedIn, a separate
product. Requesting them from a Community-Management-only app fails the whole
authorization with `unauthorized_scope_error`. Consequence: `/v2/userinfo` is
unavailable, so the authorizing member URN is not recorded.

## Configuration

| Field | Notes |
|---|---|
| `dekRef` | Secret holding 32 random bytes, base64. Envelope-encrypts stored tokens (AES-256-GCM). |
| `redirectBaseUrl` | Public origin of this instance. Redirect URI is `{base}/api/plugins/sirantd.linkedin-org/api/oauth/callback?companyId={companyId}`. Register it in the LinkedIn app for each company: LinkedIn compares the full URI, query included. |
| `clientIdRef` | Secret holding the app Client ID. |
| `clientSecretRef` | Secret holding the Primary Client Secret. |
| `defaultOrganizationUrn` | Optional. The Organization URN or the organization id of the Page that a tool call acts as when it omits `organizationId`. |

Generate a DEK with:

```bash
openssl rand -base64 32
```

## Connect

An operator connects and disconnects the Pages of a company through these
board routes. Each path starts with `/api/plugins/sirantd.linkedin-org/api`.

| Route | Request | Purpose |
|---|---|---|
| `oauth-start` | `POST /oauth/start` | Stores an OAuth state for the operator. Returns the LinkedIn authorization URL and the requested scopes. |
| `oauth-callback` | `GET /oauth/callback?companyId={companyId}` | The redirect URI. LinkedIn sends the browser of the operator here. The route finishes connect and returns `{ outcome, detail }`. |
| `oauth-complete` | `POST /oauth/complete` | Finishes connect with the redirect fields in the body: `code` and `state`, or `error` and `error_description`. Returns `{ connected }` or `{ error, kind }`. |
| `disconnect` | `POST /pages/{organizationId}/disconnect` | Revokes the Page connection of one Page. Takes the organization id or the Organization URN. Returns 404 if the company has no Page connection for the Page. |

`oauth-start` refuses a DEK that cannot seal tokens with a 500 and text that
names `dekRef`. LinkedIn then gets no request, and no authorization code is
spent.

The OAuth state is valid for one finish within 10 minutes. The first finish
uses it up, whatever the outcome, so the operator must start connect again
after a refusal. Only the operator who started connect can finish it. In
`local_trusted` mode each operator has the actor id `local-board`, so this rule
has no effect there.

Each finish gives one connect outcome. Both finish routes return the same
status for one outcome. A 400 means that the operator can remove the cause and
connect again.

| Kind | Status | Cause |
|---|---|---|
| `connected` | 200 | Each Page that the authorizing member administers has an active Page connection. |
| `declined` | 400 | The authorizing member declined, or LinkedIn refused the authorization. |
| `incomplete_redirect` | 400 | The redirect has no authorization code or no OAuth state. |
| `invalid_state` | 400 | The OAuth state is unknown, expired or used, or a different operator started connect. |
| `code_refused` | 400 | LinkedIn refused the authorization code: it expired or was used. |
| `grant_refused` | 400 | LinkedIn did not grant the needed scopes, or did not report the granted scopes. |
| `no_page` | 400 | The authorizing member administers no Page. |
| `linkedin_failed` | 502 | The token endpoint or a LinkedIn call failed. |
| `plugin_failed` | 500 | The plugin settings, the DEK or the database failed. This includes a Client ID or a Client Secret that LinkedIn refused (`invalid_client`). |

## Agent tools

| Tool | Purpose |
|---|---|
| `linkedin-page-list` | List connected Pages. |
| `linkedin-page-upload` | Upload an issue attachment for a later post by the Page. |
| `linkedin-page-post` | Publish a post authored by the Page, with an optional uploaded image or document. |
| `linkedin-page-react` | React to a post as the Page. |
| `linkedin-page-comment` | Comment on a post as the Page. |

The `organizationId` parameter takes the organization id (`12345`) or the
Organization URN (`urn:li:organization:12345`).
If a tool call omits `organizationId`, the tool acts as the default Page, else
the only active Page. If several Pages are active and no default Page is set,
the call fails. A post to the wrong company Page is not a recoverable mistake.

Each tool that acts as a Page writes one activity entry to the company activity
log after LinkedIn did the action. The metadata of the entry holds
`organizationId`, `agentId` and `runId`. If the write fails, the plugin log
keeps the failure and the tool still returns its result, so the agent does not
do the action again.

| Tool | `entityType` | `entityId` |
|---|---|---|
| `linkedin-page-upload` | `linkedin_page_media` | The media URN. |
| `linkedin-page-post` | `linkedin_page_post` | The post URN. |
| `linkedin-page-react` | `linkedin_page_reaction` | The reaction URN, or the post URN if LinkedIn returns no reaction URN. A reaction that exists already returns none. |
| `linkedin-page-comment` | `linkedin_page_comment` | The comment URN, or the post URN if LinkedIn returns no comment URN. |

### Images and documents

A post with a file takes three steps:

1. Attach the file to a Paperclip issue of the company.
2. Call `linkedin-page-upload` with the `attachmentId`. The tool returns a
   media URN (`urn:li:image:…` or `urn:li:document:…`) and its processing
   status.
3. Call `linkedin-page-post` with `mediaUrn` and the same `organizationId`. A
   document also needs `title`; an image takes an optional `altText`.

The post refuses a file that LinkedIn has not finished processing and publishes
nothing. Call it again later. It also refuses a file that LinkedIn could not
process and a file that another Page uploaded.

| Content type | LinkedIn API |
|---|---|
| `image/png`, `image/jpeg`, `image/jpg`, `image/gif` | Images API |
| `application/pdf`, `application/msword`, DOCX, `application/vnd.ms-powerpoint`, PPTX | Documents API |

The plugin uploads a file of 10 MiB or less. This is the default Paperclip
attachment limit; the worker holds the file in memory, and the host gives a tool
call 30 s.

The upload reads attachments with the `issue.attachments.read` capability. It
cannot read an attachment on a private issue that the plugin cannot see. An
upgrade from a version without this capability stops at `upgrade_pending` until
the operator approves the new capability set. The
file upload uses the Node `fetch`, because `ctx.http` cannot send bytes, so
the host tracing and audit log do not include that one request.

## Database

Namespace slug `linkedin_org`, resolving to schema
`plugin_linkedin_org_670c26f221` (derived as
`plugin_{slug}_{sha256(pluginKey)[0:10]}`). **Changing the plugin id in the
manifest changes the schema name** and invalidates `migrations/0001_pages.sql`.

## Build

```bash
npm install && npm run typecheck && npm test && npm run build
```

## Status

Live-tested 2026-09-29 against two connected Pages (PER-2499):

- **Token refresh: verified.** Forcing `expires_at` to now+1 min and then calling a
  tool refreshed both Pages. `last_refreshed_at` was set, the new expiry is +60 days,
  and the status stayed `active`. Refresh is lazy: it runs only inside a tool call
  within 5 min of expiry. Nothing refreshes on a schedule.
- **Post: verified.** `linkedin-page-post` published to AWS User Group Gold Coast.
  The `x-restli-id` header returned `urn:li:share:…` as expected.
- **Reactions / comments: need the `*_social_feed` scopes.** With only
  `w_organization_social`, LinkedIn returns 403 ACCESS_DENIED
  (`partnerApiSocialActions.CREATE` / `partnerApiReactions.CREATE`), even on the Page's
  own post. Connect now requests `r_/w_organization_social_feed`. A Page connected
  before this change refuses react and comment with a message that names the
  missing scope. Reconnect it via `oauth-start`.
- **Unverified:** the `/rest/organizations?ids=List(...)` batch projection.
- **Unverified:** image and document posts. Issue #14 lists the live tests.

There is no settings UI yet; configure via the plugin config API.
