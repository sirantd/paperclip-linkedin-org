/** A LinkedIn REST call that LinkedIn answered with an error status. */
export class LinkedInApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "LinkedInApiError";
    this.status = status;
  }
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
