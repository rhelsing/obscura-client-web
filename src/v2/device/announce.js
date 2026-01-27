/**
 * Device Announce
 * Per identity.md spec: Broadcast device list changes to friends
 */

import { sign, verify } from '../crypto/ed25519.js';

/**
 * Build DeviceAnnounce message payload
 * Per identity.md: Sent to all friends when device list changes
 *
 * @param {object} params
 * @param {Array} params.devices - Current device list
 * @param {boolean} params.isRevocation - True if this is a device removal
 * @param {Uint8Array} params.signingKey - Private key for signing (device or recovery)
 * @returns {Promise<object>} DeviceAnnounce payload
 */
export async function buildDeviceAnnounce({ devices, isRevocation, signingKey }) {
  const timestamp = Date.now();

  // Serialize devices for signing
  const devicesData = devices.map(d => ({
    deviceUUID: d.deviceUUID,
    serverUserId: d.serverUserId,
    deviceName: d.deviceName,
    signalIdentityKey: uint8ArrayToBase64(d.signalIdentityKey),
  }));

  // Create data to sign
  const dataToSign = JSON.stringify({
    devices: devicesData,
    timestamp,
    isRevocation,
  });

  // Sign with appropriate key (device key for add, recovery key for revoke)
  const signature = await sign(
    new TextEncoder().encode(dataToSign),
    signingKey
  );

  return {
    devices: devicesData,
    timestamp,
    isRevocation,
    signature: uint8ArrayToBase64(signature),
  };
}

/**
 * Parse DeviceAnnounce message payload
 * @param {object} payload - Received announce payload
 * @returns {object} Parsed announce data
 */
export function parseDeviceAnnounce(payload) {
  return {
    devices: payload.devices.map(d => ({
      deviceUUID: d.deviceUUID,
      serverUserId: d.serverUserId,
      deviceName: d.deviceName,
      signalIdentityKey: base64ToUint8Array(d.signalIdentityKey),
    })),
    timestamp: payload.timestamp,
    isRevocation: payload.isRevocation,
    signature: base64ToUint8Array(payload.signature),
  };
}

/**
 * Verify DeviceAnnounce signature
 * Per identity.md: Use device key for adds, recovery key for revocations
 *
 * @param {object} announce - Parsed announce data (or raw from buildDeviceAnnounce)
 * @param {Uint8Array} publicKey - Public key to verify against
 * @returns {Promise<{valid: boolean, error?: string}>}
 */
export async function verifyDeviceAnnounce(announce, publicKey) {
  try {
    // Recreate signed data - ensure signalIdentityKey is base64 string
    const devicesData = announce.devices.map(d => ({
      deviceUUID: d.deviceUUID,
      serverUserId: d.serverUserId,
      deviceName: d.deviceName,
      signalIdentityKey: uint8ArrayToBase64(d.signalIdentityKey),
    }));

    const dataToVerify = JSON.stringify({
      devices: devicesData,
      timestamp: announce.timestamp,
      isRevocation: announce.isRevocation,
    });

    // Convert signature to Uint8Array if it's a base64 string
    const signatureBytes = typeof announce.signature === 'string'
      ? base64ToUint8Array(announce.signature)
      : announce.signature;

    const result = await verify(
      new TextEncoder().encode(dataToVerify),
      signatureBytes,
      publicKey
    );

    return { valid: result };
  } catch (e) {
    return { valid: false, error: e.message };
  }
}

/**
 * Build DeviceAnnounce for v2 proto (uses Uint8Array directly, not base64)
 * Per identity.md: Sent to all friends when device list changes
 *
 * @param {object} params
 * @param {Array} params.devices - Current device list
 * @param {boolean} params.isRevocation - True if this is a device removal
 * @param {Uint8Array} params.signingKey - Private key for signing (device or recovery)
 * @returns {Promise<object>} DeviceAnnounce payload for proto encoding
 */
export async function buildDeviceAnnounceProto({ devices, isRevocation, signingKey }) {
  const timestamp = Date.now();

  // Prepare devices with Uint8Array for signalIdentityKey
  const devicesData = devices.map(d => ({
    deviceUUID: d.deviceUUID,
    serverUserId: d.serverUserId,
    deviceName: d.deviceName,
    signalIdentityKey: ensureUint8Array(d.signalIdentityKey),
  }));

  // Create data to sign (same format as base64 version for signature compatibility)
  const devicesForSigning = devices.map(d => ({
    deviceUUID: d.deviceUUID,
    serverUserId: d.serverUserId,
    deviceName: d.deviceName,
    signalIdentityKey: uint8ArrayToBase64(ensureUint8Array(d.signalIdentityKey)),
  }));

  const dataToSign = JSON.stringify({
    devices: devicesForSigning,
    timestamp,
    isRevocation,
  });

  // Sign with appropriate key (device key for add, recovery key for revoke)
  const signature = await sign(
    new TextEncoder().encode(dataToSign),
    signingKey
  );

  return {
    devices: devicesData,
    timestamp,
    isRevocation,
    signature: ensureUint8Array(signature),
  };
}

/**
 * Verify DeviceAnnounce signature for v2 proto format
 * Per identity.md: Use device key for adds, recovery key for revocations
 *
 * @param {object} announce - Proto-decoded announce data (Uint8Array fields)
 * @param {Uint8Array} publicKey - Public key to verify against
 * @returns {Promise<{valid: boolean, error?: string}>}
 */
export async function verifyDeviceAnnounceProto(announce, publicKey) {
  try {
    // Recreate signed data - convert Uint8Array to base64 for signature verification
    const devicesData = announce.devices.map(d => ({
      deviceUUID: d.deviceUUID,
      serverUserId: d.serverUserId,
      deviceName: d.deviceName,
      signalIdentityKey: uint8ArrayToBase64(ensureUint8Array(d.signalIdentityKey)),
    }));

    const dataToVerify = JSON.stringify({
      devices: devicesData,
      timestamp: Number(announce.timestamp),
      isRevocation: announce.isRevocation,
    });

    const signatureBytes = ensureUint8Array(announce.signature);

    const result = await verify(
      new TextEncoder().encode(dataToVerify),
      signatureBytes,
      publicKey
    );

    return { valid: result };
  } catch (e) {
    return { valid: false, error: e.message };
  }
}

function ensureUint8Array(data) {
  if (data instanceof Uint8Array) return data;
  if (Array.isArray(data)) return new Uint8Array(data);
  if (typeof data === 'string') return base64ToUint8Array(data);
  return data;
}

/**
 * Apply DeviceAnnounce to local friend data
 * Per identity.md: Update friend's device list (LWW - latest timestamp wins)
 *
 * @param {object} friendData - Current friend data
 * @param {object} announce - Parsed announce data
 * @returns {object} Updated friend data (or null if announce is older)
 */
export function applyDeviceAnnounce(friendData, announce) {
  // LWW: Only apply if newer
  const currentTimestamp = friendData.devicesUpdatedAt || 0;

  if (announce.timestamp <= currentTimestamp) {
    // Ignore older announcement
    return null;
  }

  return {
    ...friendData,
    devices: announce.devices,
    devicesUpdatedAt: announce.timestamp,
  };
}

/**
 * Get list of friend device server user IDs for fan-out
 * @param {Array} friends - List of friends with device lists
 * @returns {Array} List of server user IDs to send to
 */
export function getFanOutTargets(friends) {
  const targets = [];

  for (const friend of friends) {
    if (friend.devices && Array.isArray(friend.devices)) {
      for (const device of friend.devices) {
        targets.push(device.serverUserId);
      }
    }
  }

  return targets;
}

/**
 * Get list of own device server user IDs for self-sync fan-out
 * Used for SENT_SYNC messages to keep all devices in sync
 * @param {Array} ownDevices - List of all own devices
 * @param {string} currentDeviceId - Current device's serverUserId (to exclude)
 * @returns {Array} List of server user IDs for other own devices
 */
export function getOwnFanOutTargets(ownDevices, currentDeviceId) {
  return ownDevices
    .filter(d => d.serverUserId !== currentDeviceId)
    .map(d => d.serverUserId);
}

// Helper functions
function uint8ArrayToBase64(bytes) {
  if (!(bytes instanceof Uint8Array)) {
    return bytes; // Already base64 or other format
  }
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToUint8Array(base64) {
  if (base64 instanceof Uint8Array) {
    return base64; // Already Uint8Array
  }
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
