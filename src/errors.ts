/**
 * Iris error model.
 *
 * `message` is always safe to show to an end user (CLI or web visitor).
 * `detail` is operator-only context for logs; it never contains secrets.
 */
export type IrisErrorCode =
  | 'INVALID_INPUT'
  | 'CONFIG_ERROR'
  | 'URL_BLOCKED'
  | 'FETCH_FAILED'
  | 'NOT_HTML'
  | 'SITE_TOO_THIN'
  | 'LLM_AUTH'
  | 'LLM_RATE_LIMITED'
  | 'LLM_BAD_REQUEST'
  | 'LLM_UNAVAILABLE'
  | 'LLM_TIMEOUT'
  | 'LLM_BAD_OUTPUT'
  | 'INSUFFICIENT_EVIDENCE'
  | 'RATE_LIMITED'
  | 'BUSY'
  | 'ABORTED'
  | 'INTERNAL';

export interface IrisErrorOptions {
  cause?: unknown;
  detail?: string | undefined;
  retryAfterSeconds?: number | undefined;
}

export class IrisError extends Error {
  readonly code: IrisErrorCode;
  readonly detail: string | undefined;
  readonly retryAfterSeconds: number | undefined;

  constructor(code: IrisErrorCode, message: string, options: IrisErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'IrisError';
    this.code = code;
    this.detail = options.detail;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

export function isIrisError(value: unknown): value is IrisError {
  return value instanceof IrisError;
}

/** Errors raised before any LLM call; a failed run with one of these consumed no model quota. */
export const PRE_LLM_CODES: ReadonlySet<IrisErrorCode> = new Set([
  'INVALID_INPUT',
  'URL_BLOCKED',
  'FETCH_FAILED',
  'NOT_HTML',
  'SITE_TOO_THIN',
]);

export function toIrisError(value: unknown): IrisError {
  if (isIrisError(value)) return value;
  if (value instanceof Error && value.name === 'AbortError') {
    return new IrisError('ABORTED', 'The run was cancelled.', { cause: value });
  }
  return new IrisError('INTERNAL', 'Something went wrong inside Iris. Try again.', {
    cause: value,
    detail: value instanceof Error ? `${value.name}: ${value.message}` : String(value),
  });
}
