/**
 * Attachment URL utilities
 * Shared helpers for parsing/creating mediaUrl JSON strings
 * Used by both stories and messages
 */

/**
 * Parse mediaUrl - could be a direct URL, single attachment ref, or chunked ref
 * @param {string} mediaUrl - The stored mediaUrl value
 * @returns {object|null} - { isRef: true, isChunked: false, ref: {...} } or { isRef: true, isChunked: true, ref: {...} } or { isRef: false, url: '...' } or null
 */
export function parseMediaUrl(mediaUrl) {
  if (!mediaUrl) return null;

  // Try to parse as JSON (encrypted attachment format)
  try {
    const parsed = JSON.parse(mediaUrl);

    // Chunked attachment (large file)
    if (parsed.chunks && Array.isArray(parsed.chunks)) {
      return {
        isRef: true,
        isChunked: true,
        ref: {
          fileId: parsed.fileId,
          chunks: parsed.chunks.map(c => ({
            index: c.index,
            attachmentId: c.attachmentId,
            contentKey: new Uint8Array(c.contentKey),
            nonce: new Uint8Array(c.nonce),
            chunkHash: c.chunkHash ? new Uint8Array(c.chunkHash) : undefined,
            sizeBytes: c.sizeBytes,
          })),
          completeHash: parsed.completeHash ? new Uint8Array(parsed.completeHash) : undefined,
          contentType: parsed.contentType || 'application/octet-stream',
          totalSizeBytes: parsed.totalSizeBytes,
          fileName: parsed.fileName,
        },
      };
    }

    // Single attachment
    if (parsed.attachmentId && parsed.contentKey) {
      return {
        isRef: true,
        isChunked: false,
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

/**
 * Create mediaUrl JSON string from chunkedContentReference object
 * @param {object} ref - ChunkedContentReference with chunk array
 * @returns {string} - JSON string safe for IndexedDB storage
 */
export function createChunkedMediaUrl(ref) {
  if (!ref || !ref.chunks || ref.chunks.length === 0) return null;

  return JSON.stringify({
    fileId: ref.fileId,
    chunks: ref.chunks.map(c => ({
      index: c.index,
      attachmentId: c.attachmentId,
      contentKey: c.contentKey ? Array.from(c.contentKey) : undefined,
      nonce: c.nonce ? Array.from(c.nonce) : undefined,
      chunkHash: c.chunkHash ? Array.from(c.chunkHash) : undefined,
      sizeBytes: c.sizeBytes,
    })),
    completeHash: ref.completeHash ? Array.from(ref.completeHash) : undefined,
    contentType: ref.contentType,
    totalSizeBytes: ref.totalSizeBytes,
    fileName: ref.fileName,
  });
}
