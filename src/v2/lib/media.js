/**
 * Media Utilities
 * Handles conversion and normalization of media files for upload
 *
 * - HEIC/HEIF → JPEG conversion (iPhone photos)
 * - Video normalization (future: transcode if needed)
 * - Audio recording (voice messages)
 */

import heic2any from 'heic2any';

/**
 * Check if a file is HEIC/HEIF format
 * @param {File} file
 * @returns {boolean}
 */
export function isHeic(file) {
  const type = file.type.toLowerCase();
  return type === 'image/heic' ||
         type === 'image/heif' ||
         (type === '' && file.name && /\.(heic|heif)$/i.test(file.name));
}

/**
 * Try to convert HEIC using Canvas API (works on Safari which decodes HEIC natively)
 * @param {File|Blob} file
 * @param {number} quality
 * @returns {Promise<Blob>}
 */
async function convertHeicViaCanvas(file, quality = 0.92) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);

    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      URL.revokeObjectURL(url);

      canvas.toBlob(blob => {
        if (blob) resolve(blob);
        else reject(new Error('Canvas toBlob failed'));
      }, 'image/jpeg', quality);
    };

    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Browser cannot decode HEIC'));
    };

    img.src = url;
  });
}

/**
 * Convert HEIC/HEIF to JPEG
 * Tries heic2any first, then Canvas API (Safari), then returns original
 *
 * @param {File|Blob} file - HEIC file
 * @param {number} quality - JPEG quality 0-1 (default 0.92)
 * @returns {Promise<{blob: Blob, converted: boolean}>}
 */
export async function convertHeicToJpeg(file, quality = 0.92) {
  // Try heic2any library first
  try {
    const result = await heic2any({
      blob: file,
      toType: 'image/jpeg',
      quality,
    });
    const blob = Array.isArray(result) ? result[0] : result;
    return { blob, converted: true };
  } catch (err) {
    console.warn('[Media] heic2any failed:', err.message || err);
  }

  // Fallback: try Canvas API (works on Safari)
  try {
    const blob = await convertHeicViaCanvas(file, quality);
    return { blob, converted: true };
  } catch (err) {
    console.warn('[Media] Canvas conversion failed:', err.message || err);
  }

  // Final fallback: return original file
  // iOS/Safari recipients can still view it
  console.warn('[Media] HEIC conversion failed, uploading original');
  return { blob: file, converted: false };
}

/**
 * Normalize an image file for upload
 * - Converts HEIC/HEIF to JPEG
 * - Passes through other formats unchanged
 *
 * @param {File} file
 * @returns {Promise<{blob: Blob, contentType: string, converted: boolean}>}
 */
export async function normalizeImage(file) {
  if (isHeic(file)) {
    console.log('[Media] Converting HEIC to JPEG:', file.name);
    const { blob, converted } = await convertHeicToJpeg(file);
    return {
      blob,
      contentType: converted ? 'image/jpeg' : 'image/heic',
      converted
    };
  }

  return { blob: file, contentType: file.type || 'application/octet-stream', converted: false };
}

/**
 * Normalize any media file for upload
 * Handles images (HEIC conversion), videos, and audio
 *
 * @param {File} file
 * @returns {Promise<{bytes: Uint8Array, contentType: string, originalName: string, converted: boolean}>}
 */
export async function normalizeMedia(file) {
  let blob = file;
  let contentType = file.type || 'application/octet-stream';
  let converted = false;

  // Convert HEIC images to JPEG
  if (file.type.startsWith('image/') || isHeic(file)) {
    if (isHeic(file)) {
      console.log('[Media] Converting HEIC to JPEG:', file.name);
      const result = await convertHeicToJpeg(file);
      blob = result.blob;
      converted = result.converted;
      contentType = converted ? 'image/jpeg' : 'image/heic';
    }
  }

  // Videos and audio pass through unchanged
  // Future: could transcode HEVC to H.264 if needed

  const buffer = await blob.arrayBuffer();
  return {
    bytes: new Uint8Array(buffer),
    contentType,
    originalName: file.name,
    converted,
  };
}

/**
 * Get media type category from MIME type
 * @param {string} mimeType
 * @returns {'image'|'video'|'audio'|'file'}
 */
export function getMediaCategory(mimeType) {
  if (!mimeType) return 'file';
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('audio/')) return 'audio';
  return 'file';
}

// File size limit (nginx limit is ~1MB)
export const MAX_UPLOAD_SIZE = 950 * 1024; // 950KB - single source of truth

// Image compression constants
const MAX_IMAGE_SIZE = MAX_UPLOAD_SIZE;
const MAX_IMAGE_DIMENSION = 2048; // Max width/height in pixels

/**
 * Compress arbitrary data using gzip
 * @param {Uint8Array} data - Data to compress
 * @returns {Promise<{compressed: Uint8Array, wasCompressed: boolean}>}
 */
export async function gzipCompress(data) {
  try {
    const stream = new Blob([data]).stream();
    const compressedStream = stream.pipeThrough(new CompressionStream('gzip'));
    const compressedBlob = await new Response(compressedStream).blob();
    const compressed = new Uint8Array(await compressedBlob.arrayBuffer());

    // Only use compressed if it's actually smaller
    if (compressed.length < data.length) {
      console.log(`[Media] Gzip: ${(data.length / 1024).toFixed(0)}KB → ${(compressed.length / 1024).toFixed(0)}KB`);
      return { compressed, wasCompressed: true };
    }
    console.log(`[Media] Gzip didn't help (${(data.length / 1024).toFixed(0)}KB → ${(compressed.length / 1024).toFixed(0)}KB)`);
    return { compressed: data, wasCompressed: false };
  } catch (err) {
    console.warn('[Media] Gzip compression failed:', err);
    return { compressed: data, wasCompressed: false };
  }
}

/**
 * Check if data is gzip compressed (magic bytes: 0x1f 0x8b)
 * @param {Uint8Array} data
 * @returns {boolean}
 */
export function isGzipped(data) {
  return data.length >= 2 && data[0] === 0x1f && data[1] === 0x8b;
}

/**
 * Decompress gzip data
 * @param {Uint8Array} data - Compressed data
 * @returns {Promise<Uint8Array>}
 */
export async function gzipDecompress(data) {
  try {
    const stream = new Blob([data]).stream();
    const decompressedStream = stream.pipeThrough(new DecompressionStream('gzip'));
    const decompressedBlob = await new Response(decompressedStream).blob();
    return new Uint8Array(await decompressedBlob.arrayBuffer());
  } catch (err) {
    console.warn('[Media] Gzip decompression failed:', err);
    return data; // Return original if decompression fails
  }
}

/**
 * Auto-decompress if gzipped (detects via magic bytes)
 * @param {Uint8Array} data
 * @returns {Promise<Uint8Array>}
 */
export async function maybeDecompress(data) {
  if (isGzipped(data)) {
    console.log('[Media] Detected gzip, decompressing...');
    return gzipDecompress(data);
  }
  return data;
}

/**
 * Compress an image to fit within size and dimension limits
 * - Scales down if either dimension > maxDimension
 * - Iteratively reduces JPEG quality until under maxSizeBytes
 *
 * @param {Blob} blob - Image blob to compress
 * @param {number} maxSizeBytes - Target max size (default 1MB)
 * @param {number} maxDimension - Max width/height (default 2048px)
 * @returns {Promise<Blob>} Compressed image blob (JPEG)
 */
export async function compressImage(blob, maxSizeBytes = MAX_IMAGE_SIZE, maxDimension = MAX_IMAGE_DIMENSION) {
  // Skip non-images
  if (!blob.type?.startsWith('image/')) return blob;

  return new Promise((resolve) => {
    const img = new Image();
    const url = URL.createObjectURL(blob);

    img.onload = () => {
      URL.revokeObjectURL(url);

      // Calculate target dimensions (scale down if needed)
      let { naturalWidth: w, naturalHeight: h } = img;
      const needsResize = w > maxDimension || h > maxDimension;

      if (needsResize) {
        const scale = Math.min(maxDimension / w, maxDimension / h);
        w = Math.round(w * scale);
        h = Math.round(h * scale);
        console.log(`[Media] Resizing: ${img.naturalWidth}x${img.naturalHeight} → ${w}x${h}`);
      }

      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, w, h);

      // Try progressively lower quality until under size limit
      const qualities = [0.85, 0.7, 0.5, 0.3];

      function tryCompress(qualityIndex) {
        const quality = qualities[qualityIndex];
        canvas.toBlob((result) => {
          if (!result) {
            console.warn('[Media] toBlob returned null');
            resolve(blob);
            return;
          }
          if (result.size <= maxSizeBytes || qualityIndex >= qualities.length - 1) {
            console.log(`[Media] Compressed: ${(blob.size / 1024).toFixed(0)}KB → ${(result.size / 1024).toFixed(0)}KB (q=${quality})`);
            resolve(result);
          } else {
            console.log(`[Media] Still too large at q=${quality}: ${(result.size / 1024).toFixed(0)}KB, trying lower...`);
            tryCompress(qualityIndex + 1);
          }
        }, 'image/jpeg', quality);
      }

      // If already small enough and no resize needed, return original
      if (blob.size <= maxSizeBytes && !needsResize) {
        console.log(`[Media] Image already small enough: ${(blob.size / 1024).toFixed(0)}KB`);
        resolve(blob);
      } else {
        tryCompress(0);
      }
    };

    img.onerror = () => {
      URL.revokeObjectURL(url);
      console.warn('[Media] Failed to load image for compression');
      resolve(blob); // Return original on error
    };

    img.src = url;
  });
}

/**
 * AudioRecorder - Simple wrapper around MediaRecorder for voice messages
 */
export class AudioRecorder {
  constructor() {
    this.mediaRecorder = null;
    this.chunks = [];
    this.stream = null;
  }

  /**
   * Start recording audio
   * @returns {Promise<void>}
   */
  async start() {
    this.chunks = [];
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });

    // Prefer webm/opus, fallback to whatever's available
    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : 'audio/webm';

    this.mediaRecorder = new MediaRecorder(this.stream, { mimeType });

    this.mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) {
        this.chunks.push(e.data);
      }
    };

    this.mediaRecorder.start(100); // Collect data every 100ms
  }

  /**
   * Stop recording and get the audio blob
   * @returns {Promise<{blob: Blob, contentType: string, duration: number}>}
   */
  async stop() {
    return new Promise((resolve) => {
      const startTime = Date.now() - (this.mediaRecorder?.state === 'recording' ? 0 : 0);

      this.mediaRecorder.onstop = () => {
        const blob = new Blob(this.chunks, { type: this.mediaRecorder.mimeType });
        const duration = Math.round((Date.now() - startTime) / 1000);

        // Stop all tracks
        this.stream?.getTracks().forEach(track => track.stop());
        this.stream = null;

        resolve({
          blob,
          contentType: this.mediaRecorder.mimeType,
          duration,
        });
      };

      this.mediaRecorder.stop();
    });
  }

  /**
   * Cancel recording without saving
   */
  cancel() {
    if (this.mediaRecorder?.state === 'recording') {
      this.mediaRecorder.stop();
    }
    this.stream?.getTracks().forEach(track => track.stop());
    this.stream = null;
    this.chunks = [];
  }

  /**
   * Check if currently recording
   */
  get isRecording() {
    return this.mediaRecorder?.state === 'recording';
  }
}

/**
 * VideoRecorder - Wrapper around MediaRecorder for video capture
 */
export class VideoRecorder {
  constructor(stream) {
    this.stream = stream;
    this.mediaRecorder = null;
    this.chunks = [];
    this.startTime = null;
  }

  /**
   * Start recording video from an existing stream
   * Uses lower bitrate to keep file sizes manageable
   */
  start() {
    this.chunks = [];
    this.startTime = Date.now();

    // Prefer webm/vp9, fallback to vp8
    const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus')
      ? 'video/webm;codecs=vp9,opus'
      : 'video/webm;codecs=vp8,opus';

    // Use lower bitrate to keep file size down (500kbps video + 64kbps audio)
    // This keeps a 10-second video under 1MB
    const options = {
      mimeType,
      videoBitsPerSecond: 500000,  // 500 kbps
      audioBitsPerSecond: 64000,   // 64 kbps
    };

    this.mediaRecorder = new MediaRecorder(this.stream, options);

    this.mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) {
        this.chunks.push(e.data);
      }
    };

    this.mediaRecorder.start(100);
  }

  /**
   * Stop recording and get the video blob
   * @returns {Promise<{blob: Blob, contentType: string, duration: number}>}
   */
  async stop() {
    return new Promise((resolve) => {
      this.mediaRecorder.onstop = () => {
        const blob = new Blob(this.chunks, { type: this.mediaRecorder.mimeType });
        const duration = Math.round((Date.now() - this.startTime) / 1000);

        resolve({
          blob,
          contentType: this.mediaRecorder.mimeType,
          duration,
        });
      };

      if (this.mediaRecorder.state === 'recording') {
        this.mediaRecorder.stop();
      } else {
        resolve({ blob: new Blob([]), contentType: 'video/webm', duration: 0 });
      }
    });
  }

  /**
   * Check if currently recording
   */
  get isRecording() {
    return this.mediaRecorder?.state === 'recording';
  }
}
