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
