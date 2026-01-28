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
   *
   * @param {object} ref - ContentReference (or object with same fields)
   * @param {string} ref.attachmentId - Server attachment ID
   * @param {Uint8Array} ref.contentKey - AES-256-GCM key
   * @param {Uint8Array} ref.nonce - GCM nonce
   * @param {Uint8Array} ref.contentHash - SHA-256 for integrity
   * @returns {Promise<ArrayBuffer>} Decrypted content
   */
  async download(ref) {
    const { attachmentId, contentKey, nonce, contentHash } = ref;

    // Fetch encrypted blob from server
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
    return decryptAttachment(encryptedData, contentKey, nonce, contentHash);
  }
}
