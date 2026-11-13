export type ApiErrorCode =
  | "TIMEOUT"
  | "NETWORK_ERROR"
  | "UNAVAILABLE"
  | "NOT_FOUND"
  | "UNAUTHORIZED"
  | "SERVER_ERROR"
  | "INVALID_RESPONSE"
  | "BAD_REQUEST"
  | "UNKNOWN";

export interface ApiErrorOptions {
  status?: number;
  code?: ApiErrorCode;
  path: string;
  cause?: unknown;
  details?: unknown;
}

export class ApiError extends Error {
  readonly status?: number;
  readonly code: ApiErrorCode;
  readonly path: string;
  readonly isTimeout: boolean;
  readonly isNetworkError: boolean;
  readonly details?: unknown;

  constructor(message: string, options: ApiErrorOptions) {
    super(message);
    this.name = "ApiError";
    this.status = options.status;
    this.path = options.path;
    this.code = options.code ?? (options.status ? getCodeFromStatus(options.status) : "UNKNOWN");
    this.isTimeout = this.code === "TIMEOUT";
    this.isNetworkError = this.code === "NETWORK_ERROR" || this.code === "UNAVAILABLE";
    this.details = options.details;
    if (options.cause) {
      this.cause = options.cause;
    }
  }
}

export function getCodeFromStatus(status: number): ApiErrorCode {
  if (status === 401 || status === 403) return "UNAUTHORIZED";
  if (status === 404) return "NOT_FOUND";
  if (status === 400 || status === 422) return "BAD_REQUEST";
  if (status === 504 || status === 408) return "TIMEOUT";
  if (status >= 500) return "SERVER_ERROR";
  return "UNKNOWN";
}

export interface HumanErrorDetails {
  title: string;
  message: string;
  code: string;
  status?: number;
  path?: string;
  technicalDetails?: string;
}

/**
 * Translates raw exceptions into friendly, understandable, and safe user-facing error details.
 * Prevents raw stack traces or internal secrets from leaking.
 */
export function getHumanErrorMessage(error: unknown): HumanErrorDetails {
  if (error instanceof ApiError) {
    let title = "API Error";
    let message = error.message;

    switch (error.code) {
      case "TIMEOUT":
        if (error.path.includes("/demo/hire") || error.path.includes("/demo/claim") || error.path.includes("/demo/run")) {
          title = "Transaction Submission Timeout";
          message = "The transaction request timed out. The outcome is unknown; please check your dashboard before resubmitting to avoid duplicate actions.";
        } else {
          title = "Request Timeout";
          message = "The request timed out. The backend did not respond in time.";
        }
        break;
      case "NETWORK_ERROR":
      case "UNAVAILABLE":
        title = "Backend Unavailable";
        message = "Unable to connect to Recourse services. Please check your connection and try again.";
        break;
      case "UNAUTHORIZED":
        title = "Unauthorized";
        message = "Your session or wallet authorization is not valid for this operation.";
        break;
      case "SERVER_ERROR":
        title = "Server Error";
        message = "Recourse services are temporarily unavailable. Please try again.";
        break;
      case "NOT_FOUND":
        title = "Resource Not Found";
        message = `The requested protocol resource at ${error.path} was not found.`;
        break;
      case "INVALID_RESPONSE":
        title = "Invalid Data Received";
        message = "The Recourse backend returned an unexpected or malformed response.";
        break;
      case "BAD_REQUEST":
        title = "Invalid Request";
        message = error.message;
        break;
      default:
        title = "Connection Error";
        break;
    }

    const techParts: string[] = [];
    if (error.status) techParts.push(`Status: ${error.status}`);
    if (error.code) techParts.push(`Code: ${error.code}`);
    if (error.path) techParts.push(`Path: ${error.path}`);

    return {
      title,
      message,
      code: error.code,
      status: error.status,
      path: error.path,
      technicalDetails: techParts.join(" | "),
    };
  }

  // Handle standard Javascript errors or strings
  const rawMsg = error instanceof Error ? error.message : String(error);
  const isNetworkFailure =
    /fetch failed|network|econnrefused|aborted|failed to fetch/i.test(rawMsg);

  if (isNetworkFailure) {
    return {
      title: "Backend Unavailable",
      message: "Unable to connect to Recourse services. Please check your connection and try again.",
      code: "NETWORK_ERROR",
      technicalDetails: rawMsg,
    };
  }

  return {
    title: "Request Error",
    message: rawMsg || "An unexpected error occurred while communicating with the protocol.",
    code: "UNKNOWN",
    technicalDetails: rawMsg,
  };
}


/**
 * True for the errors the hosted demo produces while its chain restarts (a reset, or the hourly
 * rebuild): the gateway answers 502/503/504, or the connection drops. They clear on their own
 * within about a minute, so the UI shows "reconnecting" and keeps polling rather than an error.
 */
export function isTransientApiError(error: unknown): boolean {
  if (error instanceof ApiError) {
    if (error.status === 502 || error.status === 503 || error.status === 504) return true;
    return error.code === "NETWORK_ERROR" || error.code === "UNAVAILABLE";
  }
  const raw = error instanceof Error ? error.message : String(error);
  return /fetch failed|failed to fetch|network|econnrefused/i.test(raw);
}
