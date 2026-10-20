/** LinkedIn Community Management API constants. Scopes live in scopes.ts. */

/**
 * Versioned REST API (YYYYMM). LinkedIn supports each version for a minimum of
 * one year and then sunsets it: a stale value fails every call with
 * 426 NONEXISTENT_VERSION, not a warning. Latest at time of writing is 202608.
 * Re-check against learn.microsoft.com/linkedin/marketing/versioning yearly.
 * setup() logs a warning from VERSION_WARNING_AGE_MONTHS on.
 */
export const LINKEDIN_VERSION = "202608";

/** One month before the earliest sunset of LINKEDIN_VERSION. */
export const VERSION_WARNING_AGE_MONTHS = 11;

/**
 * The warning for a LINKEDIN_VERSION that is VERSION_WARNING_AGE_MONTHS or
 * more calendar months old at `now` (UTC), or null for a newer version.
 */
export function versionWarning(now: Date): string | null {
  const year = Number(LINKEDIN_VERSION.slice(0, 4));
  const month = Number(LINKEDIN_VERSION.slice(4, 6));
  const ageMonths = (now.getUTCFullYear() - year) * 12 + (now.getUTCMonth() + 1 - month);
  if (ageMonths < VERSION_WARNING_AGE_MONTHS) return null;
  return (
    `LinkedIn API version ${LINKEDIN_VERSION} is ${ageMonths} months old. LinkedIn retires a version ` +
    "after one year at the earliest. Update LINKEDIN_VERSION and release the plugin."
  );
}

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
