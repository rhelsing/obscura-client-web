/**
 * Base58 Encoding/Decoding
 * Per identity.md spec: Bitcoin alphabet for link codes
 */

// Bitcoin Base58 alphabet (no 0, O, I, l to avoid confusion)
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const ALPHABET_MAP = new Map(ALPHABET.split('').map((c, i) => [c, BigInt(i)]));
const BASE = BigInt(58);

/**
 * Encode bytes to Base58 string
 * @param {Uint8Array|ArrayBuffer} input - Bytes to encode
 * @returns {string} Base58 encoded string
 */
export function encode(input) {
  const bytes = input instanceof ArrayBuffer ? new Uint8Array(input) : input;

  if (bytes.length === 0) return '';

  // Count leading zeros
  let leadingZeros = 0;
  for (const byte of bytes) {
    if (byte === 0) leadingZeros++;
    else break;
  }

  // Convert bytes to big integer
  let num = BigInt(0);
  for (const byte of bytes) {
    num = num * BigInt(256) + BigInt(byte);
  }

  // Convert to base58
  let result = '';
  while (num > 0) {
    const remainder = num % BASE;
    num = num / BASE;
    result = ALPHABET[Number(remainder)] + result;
  }

  // Add leading '1's for leading zeros
  return '1'.repeat(leadingZeros) + result;
}

/**
 * Decode Base58 string to bytes
 * @param {string} str - Base58 encoded string
 * @returns {Uint8Array} Decoded bytes
 */
export function decode(str) {
  if (str.length === 0) return new Uint8Array(0);

  // Count leading '1's (represent leading zero bytes)
  let leadingOnes = 0;
  for (const char of str) {
    if (char === '1') leadingOnes++;
    else break;
  }

  // Convert from base58 to big integer
  let num = BigInt(0);
  for (const char of str) {
    const value = ALPHABET_MAP.get(char);
    if (value === undefined) {
      throw new Error(`Invalid Base58 character: ${char}`);
    }
    num = num * BASE + value;
  }

  // Convert big integer to bytes
  const bytes = [];
  while (num > 0) {
    bytes.unshift(Number(num % BigInt(256)));
    num = num / BigInt(256);
  }

  // Add leading zeros
  const result = new Uint8Array(leadingOnes + bytes.length);
  result.set(bytes, leadingOnes);

  return result;
}

/**
 * Encode a string (UTF-8) to Base58
 * @param {string} str - String to encode
 * @returns {string} Base58 encoded string
 */
export function encodeString(str) {
  const bytes = new TextEncoder().encode(str);
  return encode(bytes);
}

/**
 * Decode Base58 to string (UTF-8)
 * @param {string} base58 - Base58 encoded string
 * @returns {string} Decoded string
 */
export function decodeString(base58) {
  const bytes = decode(base58);
  return new TextDecoder().decode(bytes);
}

/**
 * Encode JSON object to Base58
 * @param {object} obj - Object to encode
 * @returns {string} Base58 encoded string
 */
export function encodeJSON(obj) {
  return encodeString(JSON.stringify(obj));
}

/**
 * Decode Base58 to JSON object
 * @param {string} base58 - Base58 encoded string
 * @returns {object} Decoded object
 */
export function decodeJSON(base58) {
  return JSON.parse(decodeString(base58));
}
