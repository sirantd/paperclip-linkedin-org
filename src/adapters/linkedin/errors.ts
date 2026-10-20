import { LINKEDIN_VERSION } from "./constants.js";

/**
 * What a LinkedIn REST error status means. The Page connection module decides
 * what each meaning does to a Page connection.
 */
export type LinkedInErrorKind = "token_rejected" | "access_denied" | "version_sunset" | "rate_limited" | "other";

const KIND_BY_STATUS: Readonly<Record<number, LinkedInErrorKind>> = {
  // The access token expired, was revoked or is invalid.
  401: "token_rejected",
  // The token lacks a scope, or the authorizing member lacks a role on the Page.
  403: "access_denied",
  // LinkedIn no longer supports LINKEDIN_VERSION.
  426: "version_sunset",
  429: "rate_limited",
};

/** A LinkedIn REST call that LinkedIn answered with an error status. */
export class LinkedInApiError extends Error {
  readonly status: number;
  readonly kind: LinkedInErrorKind;

  constructor(status: number, message: string) {
    super(message);
    this.name = "LinkedInApiError";
    this.status = status;
    this.kind = KIND_BY_STATUS[status] ?? "other";
  }
}

/**
 * The error for a REST response that is not ok. `call` names the call in the
 * message. A 426 is a fault of the plugin, not of a Page, so its message names
 * the developer action.
 */
export async function apiError(res: Response, call: string): Promise<LinkedInApiError> {
  const detail = `${call} ${res.status}: ${(await res.text()).slice(0, 500)}`;
  if (res.status === 426) {
    return new LinkedInApiError(
      426,
      `LinkedIn retired API version ${LINKEDIN_VERSION} (${detail}). ` +
        "Update LINKEDIN_VERSION and release the plugin. A reconnect does not help.",
    );
  }
  return new LinkedInApiError(res.status, detail);
}

/** A call to the LinkedIn OAuth token endpoint that LinkedIn answered with an error status. */
export class LinkedInOAuthError extends Error {
  readonly status: number;
  /** The OAuth `error` field, for example `invalid_grant`, or null when the body has none. */
  readonly code: string | null;

  constructor(status: number, code: string | null, message: string) {
    super(message);
    this.name = "LinkedInOAuthError";
    this.status = status;
    this.code = code;
  }
}
