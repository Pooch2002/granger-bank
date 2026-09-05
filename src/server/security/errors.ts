import "server-only";

/**
 * A small, deliberate hierarchy of application errors. Route handlers catch
 * AppError and serialize its `publicMessage` + `status`; anything that is
 * NOT an AppError is treated as unexpected and serialized as a generic
 * "internal error" (see toSafeErrorResponse below) — this is what stops a
 * stray database error from leaking a connection string or stack trace to
 * a customer.
 */
export class AppError extends Error {
  readonly status: number;
  readonly publicMessage: string;
  readonly code: string;

  constructor(params: { status: number; code: string; publicMessage: string; internalMessage?: string }) {
    super(params.internalMessage ?? params.publicMessage);
    this.status = params.status;
    this.code = params.code;
    this.publicMessage = params.publicMessage;
  }
}

export class UnauthenticatedError extends AppError {
  constructor(message = "You must be signed in to do that.") {
    super({ status: 401, code: "UNAUTHENTICATED", publicMessage: message });
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "You don't have permission to do that.") {
    super({ status: 403, code: "FORBIDDEN", publicMessage: message });
  }
}

export class NotFoundError extends AppError {
  constructor(message = "That resource could not be found.") {
    super({ status: 404, code: "NOT_FOUND", publicMessage: message });
  }
}

export class ValidationError extends AppError {
  /** Per-field messages (e.g. `{ dateOfBirth: "Invalid date" }`), safe to
   * show a user next to the offending input — unlike internalMessage on
   * other AppErrors, this is never system/infrastructure detail. */
  readonly fields?: Record<string, string>;

  constructor(message = "The submitted data is invalid.", fields?: Record<string, string>) {
    super({ status: 422, code: "VALIDATION_ERROR", publicMessage: message });
    this.fields = fields;
  }
}

export class ConflictError extends AppError {
  constructor(message = "This request conflicts with existing data.") {
    super({ status: 409, code: "CONFLICT", publicMessage: message });
  }
}

export class RateLimitedError extends AppError {
  constructor(message = "Too many attempts. Please try again later.") {
    super({ status: 429, code: "RATE_LIMITED", publicMessage: message });
  }
}

export class CsrfError extends AppError {
  constructor(message = "Your session could not be verified. Please refresh and try again.") {
    super({ status: 403, code: "CSRF_REJECTED", publicMessage: message });
  }
}

/** Thrown by every provider stub until a real, authorized provider is
 * configured. Never caught-and-faked into a success anywhere in the app. */
export class ProviderNotConfiguredError extends AppError {
  constructor(providerName: string) {
    super({
      status: 503,
      code: "PROVIDER_NOT_CONFIGURED",
      publicMessage:
        "This feature isn't available yet — it depends on a banking service that hasn't been connected.",
      internalMessage: `${providerName} is not configured for this environment.`,
    });
  }
}

/**
 * Converts any thrown value into a safe, client-facing JSON body + status
 * code. Logs the full error server-side (where PII scrubbing for the log
 * pipeline happens — see docs/production/08-deployment-architecture.md §5)
 * but never returns internals to the caller.
 */
export function toSafeErrorResponse(
  error: unknown
): { status: number; body: { error: { code: string; message: string; fields?: Record<string, string> } } } {
  if (error instanceof AppError) {
    const fields = error instanceof ValidationError ? error.fields : undefined;
    return {
      status: error.status,
      body: { error: { code: error.code, message: error.publicMessage, ...(fields ? { fields } : {}) } },
    };
  }

  // eslint-disable-next-line no-console
  console.error("[unhandled_error]", error);

  return {
    status: 500,
    body: { error: { code: "INTERNAL_ERROR", message: "Something went wrong on our end. Please try again." } },
  };
}
