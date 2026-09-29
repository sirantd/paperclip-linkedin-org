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

`r_organization_social w_organization_social rw_organization_admin`

No `openid`/`profile`/`email`: those belong to Sign In with LinkedIn, a separate
product. Requesting them from a Community-Management-only app fails the whole
authorization with `unauthorized_scope_error`. Consequence: `/v2/userinfo` is
unavailable, so the authorizing member URN is not recorded.

## Configuration

| Field | Notes |
|---|---|
| `dekRef` | Secret holding 32 random bytes, base64. Envelope-encrypts stored tokens (AES-256-GCM). |
| `redirectBaseUrl` | Public origin of this instance. Redirect URI is `{base}/api/plugins/sirantd.linkedin-org/api/oauth/complete` — register it in the LinkedIn app. |
| `clientIdRef` | Secret holding the app Client ID. |
| `clientSecretRef` | Secret holding the Primary Client Secret. |
| `defaultOrganizationUrn` | Optional. Used when a tool call omits `organizationId`. |

Generate a DEK with:

```bash
openssl rand -base64 32
```

## Agent tools

| Tool | Purpose |
|---|---|
| `linkedin-page-list` | List connected Pages. |
| `linkedin-page-post` | Publish a post authored by the Page. |
| `linkedin-page-react` | React to a post as the Page. |
| `linkedin-page-comment` | Comment on a post as the Page. |

`organizationId` is optional when exactly one Page is connected. With several
connected and no default set, calls fail rather than guess — posting to the
wrong company Page is not a recoverable mistake.

## Database

Namespace slug `linkedin_org`, resolving to schema
`plugin_linkedin_org_670c26f221` (derived as
`plugin_{slug}_{sha256(pluginKey)[0:10]}`). **Changing the plugin id in the
manifest changes the schema name** and invalidates `migrations/0001_pages.sql`.

## Build

```bash
npm install && npm run typecheck && npm run build
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
  own post. `LINKEDIN_ORG_SCOPES` now requests `r_/w_organization_social_feed`. Pages
  connected before this change must be reconnected via `oauth-start` before comment
  and react will work.
- **Unverified:** the `/rest/organizations?ids=List(...)` batch projection.

There is no settings UI yet; configure via the plugin config API.
