/**
 * Centralized Phone Normalization Utility
 * Standardizes phone numbers across search, check-in, registration, and duplicate checking.
 */
function normalizePhone(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const digits = raw.replace(/[^\d+]/g, '').trim();
  if (!digits) return null;

  // Handle +233 or 233 prefix for Ghanaian standard phone numbers
  if (digits.startsWith('+233')) {
    return '0' + digits.slice(4);
  }
  if (digits.startsWith('233') && digits.length >= 12) {
    return '0' + digits.slice(3);
  }
  // If user entered 9 digits without leading 0 (e.g., 550402859)
  if (digits.length === 9 && !digits.startsWith('0')) {
    return '0' + digits;
  }
  return digits;
}

module.exports = { normalizePhone };
