# LinkedIn Page plugin

This plugin lets Paperclip agents act as a company LinkedIn Page. An agent can publish, react and comment as the organization, not as a member.

## Language

### LinkedIn

**Page**:
A company LinkedIn Page that agents act as. LinkedIn models each Page as an organization.
_Avoid_: company Page, org page, account

**Organization id**:
The numeric LinkedIn identifier of a Page, for example `12345`.
_Avoid_: org id, Page id

**Organization URN**:
The full LinkedIn identifier of a Page: `urn:li:organization:{organization id}`.
_Avoid_: Page URN

**Organization reference**:
The organization id or the Organization URN of a Page. A tool call, the default Page setting and disconnect take either form. The Page connection interface reads it into the organization id once.
_Avoid_: org ref

**Authorizing member**:
The LinkedIn member who approves the connection in the browser. This member must be an administrator of each Page that the plugin connects.
_Avoid_: user, owner, admin

**Scope**:
A LinkedIn permission that a token carries, for example `w_organization_social`.
_Avoid_: permission

**Requested scopes**:
The scopes that connect asks LinkedIn for.

**Granted scopes**:
The scopes that LinkedIn gives a token. LinkedIn can grant fewer scopes than connect requested. Each Page connection stores its granted scopes.

**Needed scopes**:
The scopes that one step (connect, post, react, comment or upload) needs. Connect refuses a grant without the needed scopes of every step. An action refuses a Page connection without its needed scopes.

**Media URN**:
The LinkedIn identifier of a file that the plugin uploaded for a Page: `urn:li:image:…` or `urn:li:document:…`. A post can show the file only when LinkedIn has finished processing it.
_Avoid_: asset, media id

### Paperclip

**Company**:
The Paperclip company that owns a set of Page connections and its own plugin settings. It is not the LinkedIn organization.
_Avoid_: tenant, workspace, organization

**Operator**:
A Paperclip board user who connects and disconnects Pages for a company. The operator and the authorizing member can be the same person, but they are different identities.
_Avoid_: admin, user

**Page connection**:
The stored authorization that lets one company act as one Page.
_Avoid_: connected Page, integration, link, account

**Page connection status**:
The state of a Page connection. `active` means agents can use it. `expired` means the authorization cannot be renewed and the operator must reconnect. `revoked` means an operator disconnected it.

**Default Page**:
The Page that an agent acts as when a tool call names no Page. Each company can set one default Page in its plugin settings.

**Acting Page**:
The Page that one tool call acts as. It is the named Page, else the default Page, else the only active Page. With several active Pages and no choice, there is no acting Page.

**Connect**:
The operator flow that authorizes the plugin on LinkedIn. It creates a Page connection for each Page that the authorizing member administers, or renews the Page connection if one exists.
_Avoid_: install, link, onboard

**Disconnect**:
The operator action that revokes a Page connection.
_Avoid_: unlink, remove

**Activity entry**:
The record that the plugin writes to the company activity log for each action as a Page: upload, post, react and comment. The tool writes it after LinkedIn did the action. A failed write goes to the plugin log and does not change the tool result.
_Avoid_: audit entry, log entry

**OAuth state**:
The random value that connect sends to LinkedIn and that LinkedIn returns in the redirect. It belongs to the operator who started connect. It is valid for one finish within 10 minutes. The first finish uses it up, whatever the outcome.
_Avoid_: nonce, token

**Connect outcome**:
The result of one finish of connect: the connected Pages, or a refusal with its kind and operator-facing text. One connect outcome gives one HTTP status on each finish route.
_Avoid_: connect result, connect error
