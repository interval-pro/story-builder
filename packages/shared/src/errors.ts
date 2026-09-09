/** Base class for all errors raised deliberately by the system. */
export class AppError extends Error {
  public readonly code: string;
  public readonly status: number;
  public readonly details: Record<string, unknown> | undefined;

  constructor(code: string, message: string, status = 500, details?: Record<string, unknown>) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.status = status;
    this.details = details;
  }

  toJSON(): Record<string, unknown> {
    return { code: this.code, message: this.message, details: this.details };
  }
}

export class NotFoundError extends AppError {
  constructor(entity: string, id: string) {
    super('not_found', `${entity} ${id} was not found`, 404, { entity, id });
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('validation_failed', message, 400, details);
  }
}

/** Raised when a lifecycle transition is not allowed by the state machine. */
export class IllegalTransitionError extends AppError {
  constructor(from: string, to: string) {
    super('illegal_transition', `Transition ${from} -> ${to} is not allowed`, 409, { from, to });
  }
}

/** Raised when an agent or tool tries to act outside its granted capabilities. */
export class PermissionDeniedError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('permission_denied', message, 403, details);
  }
}

export class TimeoutError extends AppError {
  constructor(operation: string, ms: number) {
    super('timeout', `${operation} timed out after ${ms}ms`, 504, { operation, ms });
  }
}
