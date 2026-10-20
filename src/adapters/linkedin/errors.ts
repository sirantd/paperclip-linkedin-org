/** A LinkedIn REST call that LinkedIn answered with an error status. */
export class LinkedInApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "LinkedInApiError";
    this.status = status;
  }
}
