/** An action that an agent does as a Page. */
export type PageAction = "post" | "react" | "comment";

/**
 * Each scope that connect requests, with the steps that need it. README.md
 * shows this table; a test keeps the two equal.
 *
 * Organization-scoped permissions are only granted to apps approved for the
 * Community Management API product. `rw_organization_admin` lists the Pages
 * the authorizing member administers via /rest/organizationAcls. React and
 * comment need the feed scopes: live-tested 2026-09-29 (PER-2499), a token with
 * only `w_organization_social` can create posts but gets 403 ACCESS_DENIED on
 * partnerApiSocialActions.CREATE / partnerApiReactions.CREATE. That test added
 * both feed scopes at once and did not show which one fixed it. No step claims
 * the `r_` scopes, but connect requests them until a live test shows that react
 * and comment work without them.
 *
 * Deliberately no `openid`/`profile`/`email`: those belong to the separate
 * Sign In with LinkedIn product. An app approved only for Community Management
 * rejects the whole authorization with unauthorized_scope_error if they are
 * requested. Consequence: we cannot call /v2/userinfo, so the authorizing
 * member URN is not recorded.
 */
export const SCOPE_NEEDS: Readonly<Record<string, readonly (PageAction | "connect")[]>> = {
  r_organization_social: [],
  w_organization_social: ["post", "react", "comment"],
  r_organization_social_feed: [],
  w_organization_social_feed: ["react", "comment"],
  rw_organization_admin: ["connect"],
};

export const REQUESTED_SCOPES: readonly string[] = Object.keys(SCOPE_NEEDS);

/** Scopes that a grant must hold: a new Page connection can do every action. */
const CONNECT_SCOPES = Object.entries(SCOPE_NEEDS)
  .filter(([, needs]) => needs.length > 0)
  .map(([scope]) => scope);

/**
 * Parse the scope text of a new grant and refuse a grant that connect cannot
 * use. LinkedIn silently drops scopes the app is not approved for rather than
 * failing the authorization, so without this check a Page connection looks
 * healthy until the first action returns 403.
 */
export function grantedScopes(scope: string | null): string[] {
  if (scope === null) {
    throw new Error(
      "LinkedIn did not report the granted scopes, so the plugin cannot confirm " +
        "that it can act as the Page. Connect again.",
    );
  }
  const granted = scope.split(/[\s,]+/).filter(Boolean);
  const missing = CONNECT_SCOPES.filter((s) => !granted.includes(s));
  if (missing.length > 0) {
    throw new Error(
      `LinkedIn did not grant ${missing.join(", ")}. Confirm the app is approved ` +
        `for the Community Management API product and that the authorizing member ` +
        `is an administrator of the Page. Granted: ${scope}`,
    );
  }
  return granted;
}

/** The scopes that `action` needs and `granted` lacks. */
export function missingScopes(granted: readonly string[], action: PageAction): string[] {
  return Object.entries(SCOPE_NEEDS)
    .filter(([scope, needs]) => needs.includes(action) && !granted.includes(scope))
    .map(([scope]) => scope);
}
