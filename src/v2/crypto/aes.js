/**
 * AES-256-GCM Encryption for Attachments
 * Per identity.md spec: Client-side encryption before upload
 */

/**
 * Encrypt content with AES-256-GCM
 * @param {Blob|ArrayBuffer|Uint8Array} content - Content to encrypt
 * @returns {Promise<{encryptedBlob: Blob, contentKey: Uint8Array, nonce: Uint8Array, contentHash: Uint8Array, contentType: string, sizeBytes: number}>}
 */
export async function encryptAttachment(content) {
  // Convert to ArrayBuffer
  let plaintext;
  let contentType = 'application/octet-stream';

  if (content instanceof Blob) {
    contentType = content.type || contentType;
    plaintext = await content.arrayBuffer();
  } else if (content instanceof ArrayBuffer) {
    plaintext = content;
  } else if (content instanceof Uint8Array) {
    plaintext = content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength);
  } else {
    throw new Error('Content must be Blob, ArrayBuffer, or Uint8Array');
  }

  // Generate random key and nonce
  const contentKey = crypto.getRandomValues(new Uint8Array(32)); // AES-256
  const nonce = crypto.getRandomValues(new Uint8Array(12));       // GCM nonce

  // Calculate content hash for integrity verification
  const contentHash = new Uint8Array(await crypto.subtle.digest('SHA-256', plaintext));

  // Import key
  const key = await crypto.subtle.importKey(
    'raw',
    contentKey,
    { name: 'AES-GCM' },
    false,
    ['encrypt']
  );

  // Encrypt
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce },
    key,
    plaintext
  );

  return {
    encryptedBlob: new Blob([ciphertext], { type: 'application/octet-stream' }),
    contentKey,
    nonce,
    contentHash,
    contentType,
    sizeBytes: plaintext.byteLength,
  };
}

/**
 * Decrypt content with AES-256-GCM
 * @param {Blob|ArrayBuffer|Uint8Array} encryptedContent - Encrypted content
 * @param {Uint8Array} contentKey - 32-byte AES key
 * @param {Uint8Array} nonce - 12-byte GCM nonce
 * @param {Uint8Array} expectedHash - SHA-256 hash for verification
 * @returns {Promise<ArrayBuffer>} Decrypted content
 */
export async function decryptAttachment(encryptedContent, contentKey, nonce, expectedHash) {
  // Convert to ArrayBuffer
  let ciphertext;
  if (encryptedContent instanceof Blob) {
    ciphertext = await encryptedContent.arrayBuffer();
  } else if (encryptedContent instanceof ArrayBuffer) {
    ciphertext = encryptedContent;
  } else if (encryptedContent instanceof Uint8Array) {
    ciphertext = encryptedContent.buffer.slice(
      encryptedContent.byteOffset,
      encryptedContent.byteOffset + encryptedContent.byteLength
    );
  } else {
    throw new Error('Encrypted content must be Blob, ArrayBuffer, or Uint8Array');
  }

  // Import key
  const key = await crypto.subtle.importKey(
    'raw',
    contentKey,
    { name: 'AES-GCM' },
    false,
    ['decrypt']
  );

  // Decrypt
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: nonce },
    key,
    ciphertext
  );

  // Verify integrity
  const actualHash = new Uint8Array(await crypto.subtle.digest('SHA-256', plaintext));

  if (!constantTimeEqual(actualHash, expectedHash)) {
    throw new Error('Attachment integrity check failed: hash mismatch');
  }

  return plaintext;
}

/**
 * Constant-time comparison to prevent timing attacks
 * @param {Uint8Array} a
 * @param {Uint8Array} b
 * @returns {boolean}
 */
function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a[i] ^ b[i];
  }
  return result === 0;
}

/**
 * Helper to convert Uint8Array to base64
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function uint8ArrayToBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Helper to convert base64 to Uint8Array
 * @param {string} base64
 * @returns {Uint8Array}
 */
export function base64ToUint8Array(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
