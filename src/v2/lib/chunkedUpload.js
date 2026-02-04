/**
 * Chunked Upload/Download
 * Handles large files (>950KB, up to 100MB) by splitting into chunks
 *
 * Upload: Split → Encrypt each chunk → Upload → Return ChunkedContentReference
 * Download: Fetch chunks → Decrypt → Verify → Reassemble
 */

import { MAX_UPLOAD_SIZE, CHUNK_RATE_LIMIT } from './media.js';

/**
 * Generate a unique file ID
 */
function generateFileId() {
  return `file_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Compute SHA-256 hash of data
 * @param {Uint8Array} data
 * @returns {Promise<Uint8Array>}
 */
async function sha256(data) {
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return new Uint8Array(hashBuffer);
}

/**
 * Convert content to Uint8Array
 * @param {Blob|ArrayBuffer|Uint8Array} content
 * @returns {Promise<Uint8Array>}
 */
async function toUint8Array(content) {
  if (content instanceof Uint8Array) {
    return content;
  }
  if (content instanceof ArrayBuffer) {
    return new Uint8Array(content);
  }
  if (content instanceof Blob) {
    const buffer = await content.arrayBuffer();
    return new Uint8Array(buffer);
  }
  throw new Error('Invalid content type');
}

/**
 * Run tasks with rate limiting (X requests per second)
 * Executes sequentially with minimum spacing between requests.
 *
 * @param {Array<() => Promise>} tasks
 * @param {number} ratePerSecond - Max requests per second
 * @param {function} onProgress
 * @returns {Promise<Array>}
 */
async function rateLimitedParallel(tasks, ratePerSecond, onProgress) {
  const results = new Array(tasks.length);
  const interval = 1050 / ratePerSecond; // ms between requests (50ms buffer for safety)
  let lastRequestTime = 0;

  for (let i = 0; i < tasks.length; i++) {
    // Wait if needed to respect rate limit
    const now = Date.now();
    const elapsed = now - lastRequestTime;
    if (elapsed < interval && lastRequestTime > 0) {
      await new Promise(r => setTimeout(r, interval - elapsed));
    }
    lastRequestTime = Date.now();

    try {
      results[i] = await tasks[i]();
    } catch (err) {
      results[i] = { error: err };
    }

    if (onProgress) {
      onProgress({
        current: i + 1,
        total: tasks.length,
        percent: Math.round(((i + 1) / tasks.length) * 100)
      });
    }
  }

  return results;
}

/**
 * ChunkedUploader handles splitting, uploading, and reassembling large files
 */
export class ChunkedUploader {
  /**
   * @param {AttachmentManager} attachmentManager
   */
  constructor(attachmentManager) {
    this.attachmentManager = attachmentManager;
  }

  /**
   * Upload a large file in chunks
   * @param {Blob|ArrayBuffer|Uint8Array} content
   * @param {object} opts - { contentType, fileName, onProgress }
   * @returns {Promise<ChunkedContentReference>}
   */
  async upload(content, opts = {}) {
    const { contentType, fileName, onProgress } = opts;

    // Convert to Uint8Array
    const data = await toUint8Array(content);
    console.log(`[ChunkedUpload] Starting upload: ${data.length} bytes, ${Math.ceil(data.length / MAX_UPLOAD_SIZE)} chunks`);

    // Compute hash of complete file
    const completeHash = await sha256(data);

    // Split into chunks
    const chunks = [];
    for (let i = 0; i < data.length; i += MAX_UPLOAD_SIZE) {
      const end = Math.min(i + MAX_UPLOAD_SIZE, data.length);
      chunks.push(data.slice(i, end));
    }

    const fileId = generateFileId();
    const chunkInfos = [];

    // Progress reporting
    const reportProgress = (p) => {
      if (onProgress) {
        onProgress({
          phase: 'upload',
          current: p.current,
          total: p.total,
          percent: p.percent,
        });
      }
    };

    // Upload each chunk
    const uploadTasks = chunks.map((chunk, index) => async () => {
      // Compute chunk hash for verification
      const chunkHash = await sha256(chunk);

      // Upload via attachment manager (handles encryption)
      const ref = await this.attachmentManager.upload(chunk);

      return {
        index,
        attachmentId: ref.attachmentId,
        contentKey: ref.contentKey,
        nonce: ref.nonce,
        chunkHash,
        sizeBytes: chunk.length,
      };
    });

    // Run uploads with rate limiting
    const results = await rateLimitedParallel(uploadTasks, CHUNK_RATE_LIMIT, reportProgress);

    // Check for failures
    const failures = results.filter(r => r.error);
    if (failures.length > 0) {
      // Retry failed chunks once
      console.log(`[ChunkedUpload] ${failures.length} chunks failed, retrying...`);
      for (const failure of failures) {
        const index = results.indexOf(failure);
        const chunk = chunks[index];
        const chunkHash = await sha256(chunk);

        try {
          const ref = await this.attachmentManager.upload(chunk);
          results[index] = {
            index,
            attachmentId: ref.attachmentId,
            contentKey: ref.contentKey,
            nonce: ref.nonce,
            chunkHash,
            sizeBytes: chunk.length,
          };
        } catch (err) {
          throw new Error(`Failed to upload chunk ${index} after retry: ${err.message}`);
        }
      }
    }

    // Sort by index and build chunk list
    results.sort((a, b) => a.index - b.index);
    for (const result of results) {
      chunkInfos.push({
        index: result.index,
        attachmentId: result.attachmentId,
        contentKey: result.contentKey,
        nonce: result.nonce,
        chunkHash: result.chunkHash,
        sizeBytes: result.sizeBytes,
      });
    }

    console.log(`[ChunkedUpload] Upload complete: ${chunkInfos.length} chunks`);

    return {
      fileId,
      chunks: chunkInfos,
      completeHash,
      contentType: contentType || 'application/octet-stream',
      totalSizeBytes: data.length,
      fileName: fileName || '',
    };
  }

  /**
   * Download and reassemble a chunked file
   * @param {ChunkedContentReference} ref
   * @param {object} opts - { onProgress }
   * @returns {Promise<Uint8Array>}
   */
  async download(ref, opts = {}) {
    const { onProgress } = opts;

    console.log(`[ChunkedDownload] Starting download: ${ref.chunks.length} chunks, ${ref.totalSizeBytes} bytes`);

    // Progress reporting
    const reportProgress = (p) => {
      if (onProgress) {
        onProgress({
          phase: 'download',
          current: p.current,
          total: p.total,
          percent: p.percent,
        });
      }
    };

    // Download each chunk
    const downloadTasks = ref.chunks.map((chunkInfo) => async () => {
      // Download via attachment manager (handles decryption)
      // Pass chunkHash as contentHash for integrity verification
      const decrypted = await this.attachmentManager.download({
        attachmentId: chunkInfo.attachmentId,
        contentKey: chunkInfo.contentKey,
        nonce: chunkInfo.nonce,
        contentHash: chunkInfo.chunkHash, // Required for decryption verification
      });

      return {
        index: chunkInfo.index,
        data: new Uint8Array(decrypted), // Ensure Uint8Array
      };
    });

    // Run downloads with rate limiting
    const results = await rateLimitedParallel(downloadTasks, CHUNK_RATE_LIMIT, reportProgress);

    // Check for failures
    const failures = results.filter(r => r.error);
    if (failures.length > 0) {
      // Retry failed chunks once
      console.log(`[ChunkedDownload] ${failures.length} chunks failed, retrying...`);
      for (const failure of failures) {
        const index = results.indexOf(failure);
        const chunkInfo = ref.chunks[index];

        try {
          const decrypted = await this.attachmentManager.download({
            attachmentId: chunkInfo.attachmentId,
            contentKey: chunkInfo.contentKey,
            nonce: chunkInfo.nonce,
            contentHash: chunkInfo.chunkHash,
          });

          results[index] = {
            index: chunkInfo.index,
            data: new Uint8Array(decrypted),
          };
        } catch (err) {
          throw new Error(`Failed to download chunk ${index} after retry: ${err.message}`);
        }
      }
    }

    // Sort by index and concatenate
    results.sort((a, b) => a.index - b.index);
    const totalSize = results.reduce((sum, r) => sum + r.data.length, 0);
    const reassembled = new Uint8Array(totalSize);
    let offset = 0;
    for (const result of results) {
      reassembled.set(result.data, offset);
      offset += result.data.length;
    }

    // Verify complete hash
    if (ref.completeHash) {
      const actualHash = await sha256(reassembled);
      const expectedHash = ref.completeHash instanceof Uint8Array
        ? ref.completeHash
        : new Uint8Array(ref.completeHash);

      if (!constantTimeCompare(actualHash, expectedHash)) {
        // Debug logging for hash mismatches
        console.error('[ChunkedDownload] Hash mismatch!');
        console.error('[ChunkedDownload] Expected:', Array.from(expectedHash).map(b => b.toString(16).padStart(2, '0')).join(''));
        console.error('[ChunkedDownload] Actual:', Array.from(actualHash).map(b => b.toString(16).padStart(2, '0')).join(''));
        console.error('[ChunkedDownload] Reassembled size:', reassembled.length, 'Expected:', ref.totalSizeBytes);
        throw new Error('Complete file hash mismatch');
      }
    }

    console.log(`[ChunkedDownload] Download complete: ${reassembled.length} bytes`);

    return reassembled;
  }
}

/**
 * Constant-time comparison to prevent timing attacks
 */
function constantTimeCompare(a, b) {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a[i] ^ b[i];
  }
  return result === 0;
}

/**
 * Check if a mediaUrl ref is chunked
 * @param {object} ref - Parsed ref from parseMediaUrl
 * @returns {boolean}
 */
export function isChunkedRef(ref) {
  return ref && Array.isArray(ref.chunks) && ref.chunks.length > 0;
}
