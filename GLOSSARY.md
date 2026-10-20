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

**Authorizing member**:
The LinkedIn member who approves the connection in the browser. This member must be an administrator of each Page that the plugin connects.
_Avoid_: user, owner, admin

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
