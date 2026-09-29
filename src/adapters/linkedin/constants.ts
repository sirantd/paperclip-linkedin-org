/**
 * LinkedIn Community Management API constants.
 *
 * Organization-scoped permissions are only granted to apps approved for the
 * Community Management API product. `r_organization_social` and
 * `w_organization_social` cover reading and writing Page content;
 * `rw_organization_admin` is needed to enumerate the Pages the authorizing
 * member administers via /rest/organizationAcls.
 * `w_organization_social_feed` / `r_organization_social_feed` are required for
 * comments and reactions as the Page: live-tested 2026-09-29 (PER-2499), a
 * token with only `w_organization_social` can create posts but gets 403
 * ACCESS_DENIED on partnerApiSocialActions.CREATE / partnerApiReactions.CREATE.
 *
 * Deliberately no `openid`/`profile`/`email`: those belong to the separate
 * Sign In with LinkedIn product. An app approved only for Community Management
 * rejects the whole authorization with unauthorized_scope_error if they are
 * requested. Consequence: we cannot call /v2/userinfo, so the authorizing
 * member URN is not recorded.
 */
export const LINKEDIN_ORG_SCOPES = [
  "r_organization_social",
  "w_organization_social",
  "r_organization_social_feed",
  "w_organization_social_feed",
  "rw_organization_admin",
] as const;

/**
 * Versioned REST API (YYYYMM). LinkedIn supports each version for a minimum of
 * one year and then sunsets it: a stale value fails every call with
 * 426 NONEXISTENT_VERSION, not a warning. Latest at time of writing is 202608.
 * Re-check against learn.microsoft.com/linkedin/marketing/versioning yearly.
 */
export const LINKEDIN_VERSION = "202608";

export const LINKEDIN_AUTHORIZE_URL = "https://www.linkedin.com/oauth/v2/authorization";
export const LINKEDIN_TOKEN_URL = "https://www.linkedin.com/oauth/v2/accessToken";

export const LINKEDIN_POSTS_URL = "https://api.linkedin.com/rest/posts";
export const LINKEDIN_REACTIONS_URL = "https://api.linkedin.com/rest/reactions";
export const LINKEDIN_COMMENTS_URL = "https://api.linkedin.com/rest/socialActions";
export const LINKEDIN_ORG_ACLS_URL = "https://api.linkedin.com/rest/organizationAcls";
export const LINKEDIN_ORGS_URL = "https://api.linkedin.com/rest/organizations";
export const LINKEDIN_USERINFO_URL = "https://api.linkedin.com/v2/userinfo";

/** Headers required on every versioned REST call. */
export function restHeaders(accessToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    "LinkedIn-Version": LINKEDIN_VERSION,
    "X-Restli-Protocol-Version": "2.0.0",
    "Content-Type": "application/json",
  };
}

export function organizationUrn(organizationId: string): string {
  return organizationId.startsWith("urn:li:organization:")
    ? organizationId
    : `urn:li:organization:${organizationId}`;
}
