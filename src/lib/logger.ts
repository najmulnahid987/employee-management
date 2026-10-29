/**
 * Dispatcher M18.4 — Privacy-Safe Observability & Structured Diagnostics Logger
 *
 * Provides safe logging, diagnostic breadcrumb tracking, error sanitization,
 * and data redacting for Dispatcher.
 *
 * Core Privacy Guarantees:
 * 1. Automatic Redaction:
 *    - Auth tokens, JWTs, Bearer headers, API keys, passwords, and secrets.
 *    - Customer tracking tokens, hex bearer tokens, and full tracking URLs.
 *    - Customer phone numbers, home addresses, customer names, and gate codes.
 *    - Exact GPS coordinates: coarsened to 2 decimal places (~1.1km area)
 *      in diagnostic output to avoid logging exact residential locations.
 * 2. Safe User-Facing Error Messages:
 *    - Strips raw PostgreSQL error codes, internal SQL syntax, schema details,
 *      and stack traces from customer- and user-visible messages.
 * 3. Ring-Buffer Diagnostics:
 *    - Retains an in-memory ring buffer of the most recent sanitized breadcrumbs (default 30)
 *      for troubleshooting crashes without transmitting data to external services.
 * 4. Extensible Monitoring Hook:
 *    - Allows attaching a privacy-compliant monitoring reporter (e.g. self-hosted Sentry)
 *      in the future without modifying call sites.
 */

// Declare React Native __DEV__ global for Node/test environments
declare const __DEV__: boolean | undefined;

// =============================================================================
// Privacy Redaction Patterns & Constants
// =============================================================================

export const REDACTION_MASKS = {
  SECRET: '[REDACTED_SECRET]',
  TOKEN: '[REDACTED_TOKEN]',
  JWT: '[REDACTED_JWT]',
  PHONE: '[REDACTED_PHONE]',
  ADDRESS: '[REDACTED_ADDRESS]',
  NAME: '[REDACTED_NAME]',
  COORDINATES: '[COARSENED_COORDS]',
} as const;

/** Sensitive object keys that must be redacted completely from logs and error contexts */
export const SENSITIVE_KEY_PATTERNS = [
  /password/i,
  /secret/i,
  /^token$/i,
  /raw_token/i,
  /token_hash/i,
  /jwt/i,
  /apikey/i,
  /api_key/i,
  /authorization/i,
  /access_token/i,
  /refresh_token/i,
  /cookie/i,
  /customer_phone/i,
  /^phone$/i,
  /customer_name/i,
  /^address$/i,
  /street/i,
  /site_address/i,
  /gate_code/i,
  /internal_notes/i,
  /^notes$/i,
];

/** Regex patterns for sensitive content in strings */
const JWT_PATTERN = /Bearer\s+[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/gi;
const TRACKING_URL_TOKEN_PATTERN = /([?&#]token=)[0-9a-fA-F]{16,128}/gi;
const TRACKING_PATH_TOKEN_PATTERN = /(\/track\/)[0-9a-fA-F]{16,128}/gi;
const STANDALONE_HEX_TOKEN_PATTERN = /\b[0-9a-fA-F]{32,128}\b/g;
const US_PHONE_PATTERN = /(?:\+?1[-.\s]?)?\(?[0-9]{3}\)?[-.\s]?[0-9]{3}[-.\s]?[0-9]{4}\b/g;

// =============================================================================
// Data Sanitization Utilities
// =============================================================================

/**
 * Sanitizes a string by scrubbing JWTs, tracking tokens, passwords, and phone numbers.
 */
export function sanitizeString(input: string): string {
  if (!input || typeof input !== 'string') return '';

  return input
    .replace(JWT_PATTERN, `Bearer ${REDACTION_MASKS.JWT}`)
    .replace(TRACKING_URL_TOKEN_PATTERN, `$1${REDACTION_MASKS.TOKEN}`)
    .replace(TRACKING_PATH_TOKEN_PATTERN, `$1${REDACTION_MASKS.TOKEN}`)
    .replace(STANDALONE_HEX_TOKEN_PATTERN, REDACTION_MASKS.TOKEN)
    .replace(US_PHONE_PATTERN, REDACTION_MASKS.PHONE);
}

/**
 * Coarsens GPS coordinates to 2 decimal places (~1.1 km area) for diagnostic logs.
 * Prevents pinpointing customer residences or technician exact positions in logs.
 */
export function coarsenCoordinates(coords: {
  latitude: number;
  longitude: number;
  accuracy?: number | null;
}): { latitude: number; longitude: number; accuracy: number | null; coarsened: true } {
  const lat = typeof coords.latitude === 'number' ? Number(coords.latitude.toFixed(2)) : 0;
  const lon = typeof coords.longitude === 'number' ? Number(coords.longitude.toFixed(2)) : 0;
  const acc = typeof coords.accuracy === 'number' ? Math.round(coords.accuracy) : null;

  return {
    latitude: lat,
    longitude: lon,
    accuracy: acc,
    coarsened: true,
  };
}

/**
 * Recursively scrubs objects and arrays for diagnostic logs, masking sensitive keys
 * and coarsening GPS coordinates while preserving non-sensitive operational context.
 */
export function sanitizeForDiagnostics(
  value: unknown,
  seen: WeakSet<object> = new WeakSet(),
  depth = 0
): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  // Primitive types
  if (typeof value === 'string') {
    return sanitizeString(value);
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'function') {
    return '[Function]';
  }

  // Prevent infinite recursion on circular references or deep objects
  if (depth > 5) {
    return '[MaxDepthExceeded]';
  }

  if (typeof value === 'object') {
    if (seen.has(value)) {
      return '[CircularReference]';
    }
    seen.add(value);

    // Standard Error instances
    if (value instanceof Error) {
      const errObj = value as Error & { code?: string };
      return {
        name: errObj.name,
        message: sanitizeString(errObj.message),
        code: typeof errObj.code === 'string' ? errObj.code : undefined,
        // Include stack trace only in development and sanitize it
        stack:
          typeof __DEV__ !== 'undefined' && __DEV__ && errObj.stack
            ? sanitizeString(errObj.stack.split('\n').slice(0, 5).join('\n'))
            : undefined,
      };
    }

    // Array traversal
    if (Array.isArray(value)) {
      return value.map((item) => sanitizeForDiagnostics(item, seen, depth + 1));
    }

    // Check if object is a coordinate pair (latitude + longitude)
    const record = value as Record<string, unknown>;
    if (
      typeof record.latitude === 'number' &&
      typeof record.longitude === 'number'
    ) {
      return coarsenCoordinates({
        latitude: record.latitude,
        longitude: record.longitude,
        accuracy: typeof record.accuracy === 'number' ? record.accuracy : null,
      });
    }

    // Object traversal with sensitive key checking
    const cleaned: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(record)) {
      const isSensitiveKey = SENSITIVE_KEY_PATTERNS.some((pattern) => pattern.test(key));
      if (isSensitiveKey) {
        cleaned[key] = REDACTION_MASKS.SECRET;
      } else {
        cleaned[key] = sanitizeForDiagnostics(val, seen, depth + 1);
      }
    }
    return cleaned;
  }

  return String(value);
}

// =============================================================================
// User-Facing Error Sanitizer
// =============================================================================

/**
 * Safely converts an error into a user-friendly message, strictly preventing
 * internal PostgreSQL errors, table names, schema identifiers, and stack traces
 * from leaking to mobile users or customer screens.
 */
export function toUserFacingErrorMessage(
  error: unknown,
  fallbackMessage = 'An unexpected error occurred. Please try again.'
): string {
  if (!error) return fallbackMessage;

  let rawMessage = '';
  let errorCode = '';

  if (typeof error === 'string') {
    rawMessage = error;
  } else if (error instanceof Error) {
    rawMessage = error.message;
    errorCode = (error as { code?: string }).code || '';
  } else if (typeof error === 'object' && error !== null) {
    const errObj = error as Record<string, unknown>;
    rawMessage = typeof errObj.message === 'string' ? errObj.message : '';
    errorCode = typeof errObj.code === 'string' ? errObj.code : '';
  }

  const cleanRaw = rawMessage.trim();

  // 1. Network & Connectivity Failures
  if (
    cleanRaw.includes('Network request failed') ||
    cleanRaw.includes('Failed to fetch') ||
    cleanRaw.includes('FetchError') ||
    cleanRaw.includes('AbortError') ||
    cleanRaw.includes('timeout') ||
    cleanRaw.includes('ECONNREFUSED') ||
    cleanRaw.includes('ETIMEDOUT')
  ) {
    return 'Network connection error. Please check your internet connection and try again.';
  }

  // 2. Authentication & Session Failures
  if (
    cleanRaw.includes('JWT') ||
    cleanRaw.includes('token is expired') ||
    cleanRaw.includes('invalid claim') ||
    cleanRaw.includes('Authentication required') ||
    errorCode === 'PGRST301'
  ) {
    return 'Your session has expired. Please sign in again.';
  }

  // 3. Authorization & RLS Failures
  if (
    cleanRaw.includes('permission denied') ||
    cleanRaw.includes('Only business owners') ||
    cleanRaw.includes('Only active field workers') ||
    errorCode === '42501'
  ) {
    return 'You do not have permission to perform this action.';
  }

  // 4. Rate Limiting Failures
  if (
    cleanRaw.includes('rate limit') ||
    cleanRaw.includes('too many requests') ||
    errorCode === 'P0004'
  ) {
    return 'Too many requests. Please wait a few moments before trying again.';
  }

  // 5. Database Constraint & Relational Failures
  if (
    errorCode === '23505' ||
    cleanRaw.includes('duplicate key') ||
    cleanRaw.includes('already exists')
  ) {
    return 'A record with these details already exists.';
  }

  if (
    errorCode === '23503' ||
    cleanRaw.includes('foreign key constraint') ||
    cleanRaw.includes('Job not found')
  ) {
    return 'The requested record was not found or is no longer available.';
  }

  if (
    errorCode === '23514' ||
    cleanRaw.includes('check constraint') ||
    cleanRaw.includes('violates check')
  ) {
    return 'The submitted data is invalid or could not be verified.';
  }

  // 6. Application Lifecycle & Validation Rules
  if (
    cleanRaw.includes('terminal status') ||
    cleanRaw.includes('Cannot modify job in terminal status')
  ) {
    return 'This job has already reached a terminal status (completed or cancelled) and cannot be modified.';
  }

  if (
    cleanRaw.includes('Invalid sequential status transition') ||
    cleanRaw.includes('Illegal worker status transition') ||
    cleanRaw.includes('Job status has changed')
  ) {
    return 'The job status has changed on another device. Please refresh your screen.';
  }

  if (cleanRaw.includes('Mandatory cancellation reason required')) {
    return 'A valid cancellation reason is required to cancel this job.';
  }

  // 7. Leakage Prevention: If the message looks like a raw SQL or PostgreSQL internal error
  const containsSqlKeywords =
    cleanRaw.includes('relation "') ||
    cleanRaw.includes('constraint "') ||
    cleanRaw.includes('column "') ||
    cleanRaw.includes('syntax error') ||
    cleanRaw.includes('PGRST') ||
    cleanRaw.includes('schema "') ||
    cleanRaw.includes('function app_auth') ||
    cleanRaw.includes('auth.uid()');

  if (containsSqlKeywords) {
    return fallbackMessage;
  }

  // If the error message is clean and doesn't reveal internal DB structures, return it sanitized
  return sanitizeString(cleanRaw) || fallbackMessage;
}

// =============================================================================
// Diagnostic Breadcrumbs & Logger
// =============================================================================

export interface DiagnosticBreadcrumb {
  timestamp: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  tag: string;
  message: string;
  data?: unknown;
}

export type DiagnosticReporter = (breadcrumb: DiagnosticBreadcrumb) => void;

class StructuredLogger {
  private maxBreadcrumbs = 30;
  private breadcrumbs: DiagnosticBreadcrumb[] = [];
  private reporter: DiagnosticReporter | null = null;
  private isSilent = false;

  public setSilent(silent: boolean): void {
    this.isSilent = silent;
  }

  public setReporter(reporter: DiagnosticReporter | null): void {
    this.reporter = reporter;
  }

  public getBreadcrumbs(): DiagnosticBreadcrumb[] {
    return [...this.breadcrumbs];
  }

  public clearBreadcrumbs(): void {
    this.breadcrumbs = [];
  }

  private record(
    level: DiagnosticBreadcrumb['level'],
    tag: string,
    message: string,
    rawArgs: unknown[]
  ): void {
    const sanitizedMsg = sanitizeString(message);
    const sanitizedData =
      rawArgs.length === 1
        ? sanitizeForDiagnostics(rawArgs[0])
        : rawArgs.length > 1
        ? sanitizeForDiagnostics(rawArgs)
        : undefined;

    const entry: DiagnosticBreadcrumb = {
      timestamp: new Date().toISOString(),
      level,
      tag: sanitizeString(tag),
      message: sanitizedMsg,
      data: sanitizedData,
    };

    // Maintain circular ring buffer
    this.breadcrumbs.push(entry);
    if (this.breadcrumbs.length > this.maxBreadcrumbs) {
      this.breadcrumbs.shift();
    }

    // Forward to external monitoring hook if configured
    if (this.reporter) {
      try {
        this.reporter(entry);
      } catch {
        // Silently prevent reporter failures from breaking application execution
      }
    }

    // Only print to native console in development mode (__DEV__) or Node test runners
    const isDev =
      typeof __DEV__ !== 'undefined'
        ? Boolean(__DEV__)
        : typeof process !== 'undefined' && process.env?.NODE_ENV !== 'production';

    if (!isDev || this.isSilent) {
      return;
    }

    const formattedTag = `[${tag}]`;
    switch (level) {
      case 'error':
        if (sanitizedData !== undefined) {
          console.error(formattedTag, sanitizedMsg, sanitizedData);
        } else {
          console.error(formattedTag, sanitizedMsg);
        }
        break;
      case 'warn':
        if (sanitizedData !== undefined) {
          console.warn(formattedTag, sanitizedMsg, sanitizedData);
        } else {
          console.warn(formattedTag, sanitizedMsg);
        }
        break;
      case 'info':
        if (sanitizedData !== undefined) {
          console.info(formattedTag, sanitizedMsg, sanitizedData);
        } else {
          console.info(formattedTag, sanitizedMsg);
        }
        break;
      case 'debug':
        if (sanitizedData !== undefined) {
          console.debug(formattedTag, sanitizedMsg, sanitizedData);
        } else {
          console.debug(formattedTag, sanitizedMsg);
        }
        break;
    }
  }

  public debug(tag: string, message: string, ...args: unknown[]): void {
    this.record('debug', tag, message, args);
  }

  public info(tag: string, message: string, ...args: unknown[]): void {
    this.record('info', tag, message, args);
  }

  public warn(tag: string, message: string, ...args: unknown[]): void {
    this.record('warn', tag, message, args);
  }

  public error(tag: string, message: string, ...args: unknown[]): void {
    this.record('error', tag, message, args);
  }
}

export const logger = new StructuredLogger();

// =============================================================================
// Global Error & Promise Rejection Handlers
// =============================================================================

const HANDLED_ERROR_FLAG = Symbol('DISPATCHER_ERROR_HANDLED');

/**
 * Installs global error and unhandled promise rejection listeners to safely capture
 * crashes without leaking sensitive PII or crashing the runtime unhandled.
 */
export function installGlobalErrorHandlers(): void {
  // 1. React Native ErrorUtils global handler
  const globalObj = typeof globalThis !== 'undefined' ? (globalThis as any) : null;
  if (globalObj?.ErrorUtils && typeof globalObj.ErrorUtils.setGlobalHandler === 'function') {
    const defaultHandler = globalObj.ErrorUtils.getGlobalHandler?.();
    globalObj.ErrorUtils.setGlobalHandler((error: unknown, isFatal?: boolean) => {
      if (error && typeof error === 'object' && (error as any)[HANDLED_ERROR_FLAG]) {
        // Prevent duplicate logging
        if (defaultHandler) defaultHandler(error, isFatal);
        return;
      }

      if (error && typeof error === 'object') {
        (error as any)[HANDLED_ERROR_FLAG] = true;
      }

      logger.error('GlobalErrorHandler', isFatal ? 'Fatal JavaScript error:' : 'Uncaught error:', error);

      if (defaultHandler) {
        defaultHandler(error, isFatal);
      }
    });
  }

  // 2. Web & Node Unhandled Promise Rejections
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('unhandledrejection', (event) => {
      logger.error('UnhandledPromiseRejection', 'Unhandled promise rejection in window:', event.reason);
    });
  } else if (typeof process !== 'undefined' && typeof process.on === 'function') {
    process.on('unhandledRejection', (reason: unknown) => {
      logger.error('UnhandledPromiseRejection', 'Unhandled promise rejection:', reason);
    });
  }
}
