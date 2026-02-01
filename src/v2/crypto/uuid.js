/**
 * Device UUID Generation
 * Per identity.md spec: 16 random bytes formatted as UUID v4
 */

/**
 * Generate a random UUID v4 for device identification
 * @returns {string} UUID string (e.g., "550e8400-e29b-41d4-a716-446655440000")
 */
export function generateDeviceUUID() {
  // Use crypto.randomUUID if available (modern browsers)
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }

  // Fallback: manual UUID v4 generation
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);

  // Set version (4) and variant (RFC4122)
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // Version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // Variant RFC4122

  // Format as UUID string
  const hex = [...bytes].map(b => b.toString(16).padStart(2, '0'));
  return [
    hex.slice(0, 4).join(''),
    hex.slice(4, 6).join(''),
    hex.slice(6, 8).join(''),
    hex.slice(8, 10).join(''),
    hex.slice(10, 16).join('')
  ].join('-');
}

/**
 * Extract first 8 characters of UUID for server username suffix
 * @param {string} uuid - Full UUID
 * @returns {string} First 8 characters (e.g., "550e8400")
 * @deprecated Use generateDeviceUsername() for unlinkable device IDs
 */
export function uuidPrefix(uuid) {
  return uuid.replace(/-/g, '').slice(0, 8);
}

/**
 * Generate an unlinkable device username
 * Uses random bytes so server cannot link devices to shell account
 * @returns {string} Device username (e.g., "d_7f3a9c2b1e4d8f6a0c5b3e9d7a2f1c8b")
 */
export function generateDeviceUsername() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const hex = [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
  return `d_${hex}`;
}

/**
 * Validate UUID format
 * @param {string} uuid - String to validate
 * @returns {boolean} True if valid UUID v4 format
 */
export function isValidUUID(uuid) {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
}
