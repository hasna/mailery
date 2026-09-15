// Error taxonomy for the Mailery SDK. Zero runtime dependencies.
//
// The server always renders failures as `{ error: { code, message, details? } }`
// (see src/server/http.ts `errorBody`), so `MaileryError` normalizes that shape
// and preserves the HTTP status for callers that branch on it.

export interface MaileryErrorInit {
  status?: number;
  code?: string;
  retryable?: boolean;
  details?: unknown;
  cause?: unknown;
}

/** Any non-2xx response, network failure, or timeout raised by the SDK. */
export class MaileryError extends Error {
  readonly status?: number;
  readonly code?: string;
  readonly retryable: boolean;
  readonly details?: unknown;

  constructor(message: string, init: MaileryErrorInit = {}) {
    super(message);
    this.name = "MaileryError";
    this.status = init.status;
    this.code = init.code;
    this.retryable = init.retryable ?? false;
    this.details = init.details;
    if (init.cause !== undefined) (this as { cause?: unknown }).cause = init.cause;
  }
}

/**
 * Raised client-side, before any network call, when a method needs a credential
 * that was not supplied to the constructor (a session token for owner routes,
 * or either credential for the daily surface).
 */
export class MaileryAuthRequiredError extends MaileryError {
  constructor(message: string) {
    super(message, { code: "unauthorized", status: 401 });
    this.name = "MaileryAuthRequiredError";
  }
}

/** Raised by `waitForEntitlement` when the deadline elapses before the tenant is entitled. */
export class MaileryTimeoutError extends MaileryError {
  constructor(message: string) {
    super(message, { code: "timeout", retryable: true });
    this.name = "MaileryTimeoutError";
  }
}

/**
 * Raised by surface that maps to a server route that is planned but not yet live
 * (e.g. domain purchase, which the pivot plan ships in phase P5 behind the
 * billing-containment gate). The call never touches the network. Catch this to
 * degrade gracefully until the route ships.
 */
export class NotYetAvailableError extends MaileryError {
  constructor(message: string) {
    super(message, { code: "not_yet_available", status: 501 });
    this.name = "NotYetAvailableError";
  }
}
