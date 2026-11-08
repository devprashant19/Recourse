/** Longest response body echoed in an error, so a server cannot flood logs. */
export const MAX_ERROR_BODY = 300;

/** A non-2xx answer from 1Click. Never includes request headers (the JWT). */
export class OneClickHttpError extends Error {
  constructor(
    readonly endpoint: string,
    readonly status: number,
    body: string,
  ) {
    super(`1Click ${endpoint} returned HTTP ${status}: ${body.slice(0, MAX_ERROR_BODY)}`);
    this.name = "OneClickHttpError";
  }

  /** 429 and 5xx are worth retrying later; 4xx are not. */
  get transient(): boolean {
    return this.status === 429 || this.status >= 500;
  }
}

/** A response that does not have the shape the API promises. */
export class OneClickShapeError extends Error {
  constructor(endpoint: string, problem: string) {
    super(`1Click ${endpoint}: ${problem}`);
    this.name = "OneClickShapeError";
  }
}

/** A quote that does not match what was asked for. Never execute it. */
export class QuoteMismatchError extends Error {
  constructor(problems: string[]) {
    super(`quote rejected: ${problems.join("; ")}`);
    this.name = "QuoteMismatchError";
  }
}
