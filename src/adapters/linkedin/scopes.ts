/** An action that an agent does as a Page, with the agent tool `linkedin-page-{action}`. */
export type PageAction = "post" | "react" | "comment" | "upload" | "stats";

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
 * `r_organization_social_feed`, but connect requests it until a live test shows
 * that react and comment work without it.
 *
 * Upload, and a post with an uploaded file, also read the file status with GET
 * /rest/images or /rest/documents. The Images API lists `w_organization_social`
 * for rest/images access and calls only `w_member_social` write-only, so no `r_`
 * scope is given for that read. A live test must confirm it (issue #14).
 *
 * Stats reads the latest posts by the Page with the Posts API author finder,
 * which needs `r_organization_social`, and their counts with
 * organizationalEntityShareStatistics, which LinkedIn documents under
 * `rw_organization_admin` (learn.microsoft.com, Organization Share Statistics).
 *
 * Deliberately no `openid`/`profile`/`email`: those belong to the separate
 * Sign In with LinkedIn product. An app approved only for Community Management
 * rejects the whole authorization with unauthorized_scope_error if they are
 * requested. Consequence: we cannot call /v2/userinfo, so the authorizing
 * member URN is not recorded.
 */
export const SCOPE_NEEDS: Readonly<Record<string, readonly (PageAction | "connect")[]>> = {
  r_organization_social: ["stats"],
  w_organization_social: ["post", "react", "comment", "upload"],
  r_organization_social_feed: [],
  w_organization_social_feed: ["react", "comment"],
  rw_organization_admin: ["connect", "stats"],
};

export const REQUESTED_SCOPES: readonly string[] = Object.keys(SCOPE_NEEDS);

/** Steps that a grant may lack: connect still succeeds, and only that step refuses the Page. */
const OPTIONAL_STEPS: readonly (PageAction | "connect")[] = ["stats"];

/**
 * Scopes that a grant must hold: a new Page connection can publish, react,
 * comment and upload. A scope that only a read-only optional step (stats)
 * needs is not required, so a grant without it still connects.
 */
const CONNECT_SCOPES = Object.entries(SCOPE_NEEDS)
  .filter(([, needs]) => needs.some((n) => !OPTIONAL_STEPS.includes(n)))
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
