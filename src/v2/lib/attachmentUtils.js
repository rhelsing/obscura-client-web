/**
 * Attachment URL utilities
 * Shared helpers for parsing/creating mediaUrl JSON strings
 * Used by both stories and messages
 */

/**
 * Parse mediaUrl - could be a direct URL or a JSON attachment reference
 * @param {string} mediaUrl - The stored mediaUrl value
 * @returns {object|null} - { isRef: true, ref: {...} } or { isRef: false, url: '...' } or null
 */
export function parseMediaUrl(mediaUrl) {
  if (!mediaUrl) return null;

  // Try to parse as JSON (encrypted attachment format)
  try {
    const parsed = JSON.parse(mediaUrl);
    if (parsed.attachmentId && parsed.contentKey) {
      return {
        isRef: true,
        ref: {
          attachmentId: parsed.attachmentId,
          contentKey: new Uint8Array(parsed.contentKey),
          nonce: new Uint8Array(parsed.nonce),
          contentHash: parsed.contentHash ? new Uint8Array(parsed.contentHash) : undefined,
          contentType: parsed.contentType || 'application/octet-stream',
          fileName: parsed.fileName, // Preserve filename for file attachments
          sizeBytes: parsed.sizeBytes,
        },
      };
    }
  } catch {
    // Not JSON, check for direct URL
  }

  // Direct URL (legacy or external)
  if (mediaUrl.startsWith('http') || mediaUrl.startsWith('blob:') || mediaUrl.startsWith('data:')) {
    return { isRef: false, url: mediaUrl };
  }

  return null;
}

/**
 * Create mediaUrl JSON string from contentReference object
 * @param {object} ref - ContentReference with Uint8Array fields
 * @returns {string} - JSON string safe for IndexedDB storage
 */
export function createMediaUrl(ref) {
  if (!ref || !ref.attachmentId) return null;

  return JSON.stringify({
    attachmentId: ref.attachmentId,
    contentKey: ref.contentKey ? Array.from(ref.contentKey) : undefined,
    nonce: ref.nonce ? Array.from(ref.nonce) : undefined,
    contentHash: ref.contentHash ? Array.from(ref.contentHash) : undefined,
    contentType: ref.contentType,
    sizeBytes: ref.sizeBytes,
    fileName: ref.fileName, // Preserve filename for file attachments
  });
}
