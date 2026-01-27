/**
 * Device Linking
 * Per identity.md spec: QR code (base58) for linking new devices
 */

import { encodeJSON, decodeJSON } from '../crypto/base58.js';
import { sign, verify } from '../crypto/ed25519.js';
import { compress, decompress } from '../crypto/compress.js';

/**
 * Generate a link code for a new device
 * Per identity.md: New device displays this for existing device to scan
 *
 * @param {object} params
 * @param {string} params.serverUserId - Device's server username (e.g., "alice_def456")
 * @param {Uint8Array} params.signalIdentityKey - Device's Signal identity public key
 * @returns {string} Base58-encoded link code
 */
export function generateLinkCode({ serverUserId, signalIdentityKey }) {
  // Generate random challenge
  const challenge = new Uint8Array(16);
  crypto.getRandomValues(challenge);

  const linkData = {
    serverUserId,
    signalIdentityKey: uint8ArrayToBase64(signalIdentityKey),
    challenge: uint8ArrayToBase64(challenge),
    timestamp: Date.now(),
  };

  return encodeJSON(linkData);
}

/**
 * Parse a link code
 * @param {string} linkCode - Base58-encoded link code
 * @returns {object} Parsed link data
 */
export function parseLinkCode(linkCode) {
  const data = decodeJSON(linkCode);

  return {
    serverUserId: data.serverUserId,
    signalIdentityKey: base64ToUint8Array(data.signalIdentityKey),
    challenge: base64ToUint8Array(data.challenge),
    timestamp: data.timestamp,
  };
}

/**
 * Validate a link code
 * @param {string} linkCode - Base58-encoded link code
 * @param {number} maxAgeMs - Maximum age in milliseconds (default 5 minutes)
 * @returns {object} { valid: boolean, error?: string, data?: object }
 */
export function validateLinkCode(linkCode, maxAgeMs = 5 * 60 * 1000) {
  try {
    const data = parseLinkCode(linkCode);

    // Check timestamp
    const age = Date.now() - data.timestamp;
    if (age > maxAgeMs) {
      return { valid: false, error: 'Link code expired' };
    }

    // Check required fields
    if (!data.serverUserId || !data.signalIdentityKey || !data.challenge) {
      return { valid: false, error: 'Invalid link code format' };
    }

    return { valid: true, data };
  } catch (err) {
    return { valid: false, error: 'Could not parse link code' };
  }
}

/**
 * Build DeviceLinkApproval message payload
 * Per identity.md: Sent from existing device to new device
 *
 * @param {object} params
 * @param {Uint8Array} params.p2pPublicKey - P2P identity public key
 * @param {Uint8Array} params.p2pPrivateKey - P2P identity private key (transferred securely)
 * @param {Uint8Array} params.recoveryPublicKey - Recovery public key
 * @param {Uint8Array} params.challenge - Challenge from link code
 * @param {Array} params.ownDevices - List of all devices including new one
 * @param {object} params.dbExport - Full database export for sync
 * @returns {object} DeviceLinkApproval payload
 */
export function buildLinkApproval({
  p2pPublicKey,
  p2pPrivateKey,
  recoveryPublicKey,
  challenge,
  ownDevices,
  dbExport,
}) {
  return {
    p2pPublicKey: uint8ArrayToBase64(p2pPublicKey),
    p2pPrivateKey: uint8ArrayToBase64(p2pPrivateKey),
    recoveryPublicKey: uint8ArrayToBase64(recoveryPublicKey),
    challengeResponse: uint8ArrayToBase64(challenge),
    ownDevices: ownDevices.map(d => ({
      deviceUUID: d.deviceUUID,
      serverUserId: d.serverUserId,
      deviceName: d.deviceName,
      signalIdentityKey: uint8ArrayToBase64(d.signalIdentityKey),
    })),
    dbExport: dbExport, // Already serialized
  };
}

/**
 * Parse DeviceLinkApproval message payload
 * @param {object} payload - Received approval payload
 * @returns {object} Parsed approval data
 */
export function parseLinkApproval(payload) {
  return {
    p2pPublicKey: base64ToUint8Array(payload.p2pPublicKey),
    p2pPrivateKey: base64ToUint8Array(payload.p2pPrivateKey),
    recoveryPublicKey: base64ToUint8Array(payload.recoveryPublicKey),
    challengeResponse: base64ToUint8Array(payload.challengeResponse),
    ownDevices: payload.ownDevices.map(d => ({
      deviceUUID: d.deviceUUID,
      serverUserId: d.serverUserId,
      deviceName: d.deviceName,
      signalIdentityKey: base64ToUint8Array(d.signalIdentityKey),
    })),
    dbExport: payload.dbExport,
  };
}

/**
 * Verify link approval challenge matches
 * @param {Uint8Array} expectedChallenge - Challenge we sent
 * @param {Uint8Array} receivedChallenge - Challenge in approval
 * @returns {boolean}
 */
export function verifyChallenge(expectedChallenge, receivedChallenge) {
  // Handle both Uint8Array and regular arrays (from proto decoding)
  const expected = expectedChallenge instanceof Uint8Array ? expectedChallenge : new Uint8Array(expectedChallenge);
  const received = receivedChallenge instanceof Uint8Array ? receivedChallenge : new Uint8Array(receivedChallenge);

  if (expected.length !== received.length) {
    return false;
  }

  let result = 0;
  for (let i = 0; i < expected.length; i++) {
    result |= expected[i] ^ received[i];
  }

  return result === 0;
}

/**
 * Build DeviceLinkApproval for v2 proto (uses Uint8Array directly, not base64)
 * Per identity.md: Sent from existing device to new device
 *
 * @param {object} params
 * @param {Uint8Array} params.p2pPublicKey - P2P identity public key
 * @param {Uint8Array} params.p2pPrivateKey - P2P identity private key (transferred securely)
 * @param {Uint8Array} params.recoveryPublicKey - Recovery public key
 * @param {Uint8Array} params.challenge - Challenge from link code
 * @param {Array} params.ownDevices - List of all devices including new one
 * @returns {object} DeviceLinkApproval payload for proto encoding
 */
export function buildLinkApprovalProto({
  p2pPublicKey,
  p2pPrivateKey,
  recoveryPublicKey,
  challenge,
  ownDevices,
}) {
  return {
    p2pPublicKey: ensureUint8Array(p2pPublicKey),
    p2pPrivateKey: ensureUint8Array(p2pPrivateKey),
    recoveryPublicKey: ensureUint8Array(recoveryPublicKey),
    challengeResponse: ensureUint8Array(challenge),
    ownDevices: ownDevices.map(d => ({
      deviceUUID: d.deviceUUID,
      serverUserId: d.serverUserId,
      deviceName: d.deviceName,
      signalIdentityKey: ensureUint8Array(d.signalIdentityKey),
    })),
    // Proto doesn't include dbExport as structured fields - use optional bytes fields
    friendsExport: new Uint8Array(0),
    sessionsExport: new Uint8Array(0),
    trustedIdsExport: new Uint8Array(0),
  };
}

function ensureUint8Array(data) {
  if (data instanceof Uint8Array) return data;
  if (Array.isArray(data)) return new Uint8Array(data);
  if (typeof data === 'string') return base64ToUint8Array(data);
  return data;
}

// Helper functions
function uint8ArrayToBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToUint8Array(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// =============================================================================
// Sync Blob (Full State Transfer)
// =============================================================================

/**
 * Build a sync blob for full state transfer to new device
 * @param {object} params
 * @param {object} params.friendStore - Friend store instance
 * @param {object} params.messageStore - Message store instance
 * @param {object} params.settings - Settings object (optional)
 * @returns {Promise<Uint8Array>} Compressed sync blob
 */
export async function buildSyncBlob({ friendStore, messageStore, settings = {} }) {
  // Export all data
  const friendsData = await friendStore.exportAll();
  const messagesData = await messageStore.exportAll();

  const blob = {
    friends: friendsData.friends || [],
    messages: messagesData || [],
    settings,
  };

  // Compress and return
  return compress(blob);
}

/**
 * Apply a sync blob to local stores
 * @param {Uint8Array} compressedData - Compressed sync blob
 * @param {object} params
 * @param {object} params.friendStore - Friend store instance
 * @param {object} params.messageStore - Message store instance
 * @param {function} params.onSettings - Callback for settings (optional)
 * @returns {Promise<object>} Summary of imported data
 */
export async function applySyncBlob(compressedData, { friendStore, messageStore, onSettings }) {
  // Decompress
  const blob = await decompress(compressedData);

  const summary = {
    friends: 0,
    messages: 0,
    hasSettings: false,
  };

  // Import friends
  if (blob.friends && Array.isArray(blob.friends)) {
    await friendStore.importAll({ friends: blob.friends });
    summary.friends = blob.friends.length;
  }

  // Import messages
  if (blob.messages && Array.isArray(blob.messages)) {
    await messageStore.importMessages(blob.messages);
    summary.messages = blob.messages.length;
  }

  // Handle settings
  if (blob.settings && typeof onSettings === 'function') {
    await onSettings(blob.settings);
    summary.hasSettings = true;
  }

  return summary;
}
