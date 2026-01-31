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
      throw new Error(`Attachment upload failed: ${res.status} ${text}`);
    }

    const { id, expiresAt } = await res.json();

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
      throw new Error(`Attachment download failed: ${res.status} ${text}`);
    }

    const encryptedData = new Uint8Array(await res.arrayBuffer());

    // Decrypt and verify integrity
    const decrypted = await decryptAttachment(encryptedData, contentKey, nonce, contentHash);

    // Cache the decrypted content
    if (this.cache) {
      await this.cache.put(attachmentId, decrypted, { contentType, sizeBytes });
    }

    return decrypted;
  }
}
