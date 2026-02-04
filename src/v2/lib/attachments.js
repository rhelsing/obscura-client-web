/**
 * Attachment Manager
 * Handles encrypted attachment upload/download
 *
 * Flow:
 * 1. Upload: encrypt blob with AES-256-GCM → POST to server → return ContentReference
 * 2. Share: send ContentReference to recipients via Signal (they get the AES key)
 * 3. Download: GET encrypted blob from server → decrypt with key from ContentReference
 */

import { encryptAttachment, decryptAttachment } from '../crypto/aes.js';
import { logger } from './logger.js';
import { ChunkedUploader } from './chunkedUpload.js';
import { MAX_UPLOAD_SIZE } from './media.js';

export class AttachmentManager {
  constructor(opts = {}) {
    this.apiUrl = opts.apiUrl;
    this.token = opts.token;
    this.cache = opts.cache || null; // Optional attachment cache (IndexedDB)
  }

  /**
   * Update auth token
   */
  setToken(token) {
    this.token = token;
  }

  /**
   * Upload and encrypt a blob
   * Returns ContentReference with all info needed to share + download
   *
   * @param {Blob|ArrayBuffer|Uint8Array} content - Content to upload
   * @returns {Promise<{attachmentId: string, contentKey: Uint8Array, nonce: Uint8Array, contentHash: Uint8Array, contentType: string, sizeBytes: number, expiresAt?: number}>}
   */
  async upload(content) {
    // Encrypt client-side
    const encrypted = await encryptAttachment(content);

    // Upload to server
    const res = await fetch(`${this.apiUrl}/v1/attachments`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'Authorization': `Bearer ${this.token}`,
      },
      body: encrypted.encryptedBlob,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const error = new Error(`Attachment upload failed: ${res.status} ${text}`);
      await logger.logAttachmentUploadError(error, res.status, encrypted.sizeBytes);
      throw error;
    }

    const { id, expiresAt } = await res.json();
    await logger.logAttachmentUpload(id, encrypted.sizeBytes, encrypted.contentType);

    // Cache the original (decrypted) bytes so future downloads are instant cache hits
    // This helps the uploader on page refresh - other users/devices cache on download()
    if (this.cache) {
      const bytes = content instanceof Uint8Array
        ? content
        : new Uint8Array(content instanceof ArrayBuffer ? content : await content.arrayBuffer());
      await this.cache.put(id, bytes, { contentType: encrypted.contentType, sizeBytes: encrypted.sizeBytes });
      console.log('[Attachments] Cached on upload:', id.slice(0, 8));
    }

    // Return ContentReference-compatible object
    return {
      attachmentId: id,
      contentKey: encrypted.contentKey,
      nonce: encrypted.nonce,
      contentHash: encrypted.contentHash,
      contentType: encrypted.contentType,
      sizeBytes: encrypted.sizeBytes,
      expiresAt,
    };
  }

  /**
   * Download and decrypt an attachment
   * Uses local cache if available, otherwise fetches from server and caches.
   *
   * @param {object} ref - ContentReference (or object with same fields)
   * @param {string} ref.attachmentId - Server attachment ID
   * @param {Uint8Array} ref.contentKey - AES-256-GCM key
   * @param {Uint8Array} ref.nonce - GCM nonce
   * @param {Uint8Array} ref.contentHash - SHA-256 for integrity
   * @returns {Promise<ArrayBuffer>} Decrypted content
   */
  async download(ref) {
    const { attachmentId, contentKey, nonce, contentHash, contentType, sizeBytes } = ref;

    // Check cache first
    if (this.cache) {
      const cached = await this.cache.get(attachmentId);
      if (cached) {
        console.log('[Attachments] Cache hit:', attachmentId.slice(0, 8));
        await logger.logAttachmentCacheHit(attachmentId);
        // Track cache action for tests (avoids race conditions with console listeners)
        if (typeof window !== 'undefined') {
          window.__lastCacheAction = { type: 'hit', id: attachmentId, timestamp: Date.now() };
        }
        return cached;
      }
    }

    // Fetch encrypted blob from server
    console.log('[Attachments] Cache miss, fetching:', attachmentId.slice(0, 8));
    // Track cache action for tests
    if (typeof window !== 'undefined') {
      window.__lastCacheAction = { type: 'miss', id: attachmentId, timestamp: Date.now() };
    }
    const res = await fetch(`${this.apiUrl}/v1/attachments/${attachmentId}`, {
      headers: {
        'Authorization': `Bearer ${this.token}`,
      },
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const error = new Error(`Attachment download failed: ${res.status} ${text}`);
      await logger.logAttachmentDownloadError(attachmentId, error, res.status);
      throw error;
    }

    const encryptedData = new Uint8Array(await res.arrayBuffer());

    // Decrypt and verify integrity
    const decrypted = await decryptAttachment(encryptedData, contentKey, nonce, contentHash);
    await logger.logAttachmentDownload(attachmentId, sizeBytes || decrypted.byteLength, false);

    // Cache the decrypted content
    if (this.cache) {
      await this.cache.put(attachmentId, decrypted, { contentType, sizeBytes });
    }

    return decrypted;
  }

  /**
   * Smart upload - automatically uses chunked upload for large files
   * @param {Blob|ArrayBuffer|Uint8Array} content - Content to upload
   * @param {object} opts - { contentType, fileName, onProgress }
   * @returns {Promise<ContentReference|ChunkedContentReference>}
   */
  async uploadSmart(content, opts = {}) {
    // Get content size and bytes
    let size;
    let bytes;
    if (content instanceof Uint8Array) {
      size = content.length;
      bytes = content;
    } else if (content instanceof ArrayBuffer) {
      size = content.byteLength;
      bytes = new Uint8Array(content);
    } else if (content instanceof Blob) {
      size = content.size;
      bytes = new Uint8Array(await content.arrayBuffer());
    } else {
      throw new Error('Invalid content type');
    }

    // Use chunked upload for large files
    if (size > MAX_UPLOAD_SIZE) {
      console.log(`[Attachments] Large file (${(size / 1024 / 1024).toFixed(1)}MB), using chunked upload`);
      const chunked = new ChunkedUploader(this);
      const ref = await chunked.upload(content, opts);

      // Cache the FULL assembled file by fileId (sender doesn't need to re-download chunks)
      if (this.cache && ref.fileId) {
        await this.cache.put(ref.fileId, bytes, {
          contentType: ref.contentType || opts.contentType,
          sizeBytes: ref.totalSizeBytes,
        });
        console.log('[Attachments] Cached full file on upload:', ref.fileId.slice(0, 16));

        // Delete individual chunk caches - we have the full file now
        for (const chunk of ref.chunks) {
          await this.cache.delete(chunk.attachmentId).catch(() => {});
        }
        console.log(`[Attachments] Deleted ${ref.chunks.length} chunk caches`);
      }

      return {
        isChunked: true,
        ref,
      };
    }

    // Regular single upload
    const ref = await this.upload(content);
    if (opts.fileName) {
      ref.fileName = opts.fileName;
    }
    return {
      isChunked: false,
      ref,
    };
  }

  /**
   * Smart download - handles both single and chunked attachments
   * @param {object} refData - { isChunked, ref } from uploadSmart or parseMediaUrl
   * @param {object} opts - { onProgress }
   * @returns {Promise<Uint8Array>}
   */
  async downloadSmart(refData, opts = {}) {
    if (refData.isChunked) {
      // Check if we have the full file cached (sender or previous download)
      if (this.cache && refData.ref.fileId) {
        const cached = await this.cache.get(refData.ref.fileId);
        if (cached) {
          console.log('[Attachments] Full file cache hit:', refData.ref.fileId.slice(0, 16));
          return cached instanceof Uint8Array ? cached : new Uint8Array(cached);
        }
      }

      console.log(`[Attachments] Chunked download: ${refData.ref.chunks.length} chunks`);
      const chunked = new ChunkedUploader(this);
      const result = await chunked.download(refData.ref, opts);

      // Cache the full assembled file by fileId for future access
      if (this.cache && refData.ref.fileId) {
        await this.cache.put(refData.ref.fileId, result, {
          contentType: refData.ref.contentType,
          sizeBytes: refData.ref.totalSizeBytes,
        });
        console.log('[Attachments] Cached full file after download:', refData.ref.fileId.slice(0, 16));

        // Delete individual chunk caches - we have the full file now
        for (const chunk of refData.ref.chunks) {
          await this.cache.delete(chunk.attachmentId).catch(() => {});
        }
        console.log(`[Attachments] Deleted ${refData.ref.chunks.length} chunk caches`);
      }

      return result;
    }

    // Regular single download
    const result = await this.download(refData.ref);
    return result instanceof Uint8Array ? result : new Uint8Array(result);
  }
}
