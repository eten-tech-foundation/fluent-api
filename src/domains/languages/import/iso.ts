/**
 * Normalize and validate an ISO 639-3 language code.
 * Returns the lowercased 3-letter code if valid, or `null` if the input is
 * missing, empty, or does not match the `[a-z]{3}` pattern.
 */
export function normalizeIso6393Code(raw: string | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim().toLowerCase();
  return /^[a-z]{3}$/.test(trimmed) ? trimmed : null;
}
