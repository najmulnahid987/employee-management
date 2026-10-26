/**
 * Dispatcher Phone Normalization & Validation Utility
 *
 * Implements international E.164-compatible phone number normalization and format validation.
 * Crucial Invariant: Never assumes a single country code (e.g. Bangladesh +880 or US +1).
 * Preserves explicit international '+' prefixes without mutating the dial code.
 */

export interface PhoneValidationResult {
  isValid: boolean;
  error?: string;
  normalized: string;
}

/**
 * Normalizes phone numbers by trimming whitespace and stripping common
 * punctuation characters (parentheses, hyphens, periods, spaces) while
 * preserving an international leading '+' prefix.
 *
 * Examples:
 * - "  +1 (555) 234-5678 " -> "+15552345678"
 * - "(555) 234-5678"       -> "5552345678"
 * - "+44 20 7946 0958"     -> "+442079460958"
 * - "01712-345678"         -> "01712345678"
 */
export function normalizePhoneNumber(raw: string): string {
  if (!raw) return '';
  const trimmed = raw.trim();
  const hasLeadingPlus = trimmed.startsWith('+');

  // Strip everything except numeric digits
  const digitsOnly = trimmed.replace(/\D/g, '');

  if (!digitsOnly) return '';

  return hasLeadingPlus ? `+${digitsOnly}` : digitsOnly;
}

/**
 * Validates that the phone number contains a reasonable number of digits
 * under international numbering standards (ITU-T E.164: 7 to 15 digits).
 *
 * NOTE: Format validation verifies structural sanity only; it does not and
 * cannot prove that a telecommunication line is active or reachable.
 */
export function validatePhoneNumber(raw: string): PhoneValidationResult {
  const trimmed = raw.trim();

  if (!trimmed) {
    return {
      isValid: false,
      error: 'Customer phone number is required.',
      normalized: '',
    };
  }

  // Reject any letters or invalid special characters (e.g. "555-CALL-NOW")
  const invalidCharsRegex = /[a-zA-Z!@#$%^&*_=]/;
  if (invalidCharsRegex.test(trimmed)) {
    return {
      isValid: false,
      error: 'Phone number cannot contain letters or special symbols.',
      normalized: '',
    };
  }

  const normalized = normalizePhoneNumber(trimmed);
  const digits = normalized.replace(/\D/g, '');

  if (digits.length < 7) {
    return {
      isValid: false,
      error: 'Please enter a valid phone number (at least 7 digits).',
      normalized,
    };
  }

  if (digits.length > 15) {
    return {
      isValid: false,
      error: 'Phone number cannot exceed 15 digits under international standards.',
      normalized,
    };
  }

  return {
    isValid: true,
    normalized,
  };
}
