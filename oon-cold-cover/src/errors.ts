export type ErrorCode =
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'VALIDATION_FAILED'
  | 'CONFLICT'
  | 'NOT_ELIGIBLE'
  | 'CSRF';

const STATUS: Record<ErrorCode, number> = {
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  VALIDATION_FAILED: 422,
  CONFLICT: 409,
  NOT_ELIGIBLE: 409,
  CSRF: 403,
};

export class AppError extends Error {
  readonly status: number;
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.status = STATUS[code];
  }
}

export const forbidden = (msg = 'You do not have permission for this action.') => new AppError('FORBIDDEN', msg);
export const notFound = (what = 'Record') => new AppError('NOT_FOUND', `${what} not found.`);
export const invalid = (msg: string, details?: unknown) => new AppError('VALIDATION_FAILED', msg, details);
export const conflict = (msg: string, details?: unknown) => new AppError('CONFLICT', msg, details);
