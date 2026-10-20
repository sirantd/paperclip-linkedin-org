/** LinkedIn Community Management API constants. Scopes live in scopes.ts. */

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
