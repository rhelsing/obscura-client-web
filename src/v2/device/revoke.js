/**
 * Device Revocation
 * Per identity.md spec: Revoke device using 12-word recovery phrase
 */

import { deriveKeypair, validateMnemonic } from '../crypto/bip39.js';
import { constantTimeEqual } from '../crypto/ed25519.js';
import { buildDeviceAnnounce } from './announce.js';

/**
 * Verify recovery phrase matches stored public key
 * Per identity.md: User must enter phrase to revoke devices
 *
 * @param {string} phrase - 12-word recovery phrase
 * @param {Uint8Array} storedPublicKey - Stored recovery public key
 * @returns {Promise<{valid: boolean, keypair?: object, error?: string}>}
 */
export async function verifyRecoveryPhrase(phrase, storedPublicKey) {
  // Validate mnemonic format
  const isValidFormat = await validateMnemonic(phrase);
  if (!isValidFormat) {
    return { valid: false, error: 'Invalid recovery phrase format' };
  }

  // Derive keypair from phrase
  const keypair = await deriveKeypair(phrase);

  // Compare public keys
  if (!constantTimeEqual(keypair.publicKey, storedPublicKey)) {
    return { valid: false, error: 'Recovery phrase does not match' };
  }

  return { valid: true, keypair };
}

/**
 * Revoke a device
 * Per identity.md: Creates DeviceAnnounce signed with recovery key
 *
 * @param {object} params
 * @param {string} params.phrase - 12-word recovery phrase
 * @param {Uint8Array} params.storedRecoveryPublicKey - Stored recovery public key
 * @param {Array} params.currentDevices - Current list of devices
 * @param {string} params.deviceUUIDToRevoke - UUID of device to revoke
 * @returns {Promise<{success: boolean, announce?: object, newDeviceList?: Array, error?: string}>}
 */
export async function revokeDevice({
  phrase,
  storedRecoveryPublicKey,
  currentDevices,
  deviceUUIDToRevoke,
}) {
  // Step 1: Verify recovery phrase
  const verification = await verifyRecoveryPhrase(phrase, storedRecoveryPublicKey);
  if (!verification.valid) {
    return { success: false, error: verification.error };
  }

  // Step 2: Find and remove device
  const deviceToRevoke = currentDevices.find(d => d.deviceUUID === deviceUUIDToRevoke);
  if (!deviceToRevoke) {
    return { success: false, error: 'Device not found' };
  }

  // Step 3: Create new device list without revoked device
  const newDeviceList = currentDevices.filter(d => d.deviceUUID !== deviceUUIDToRevoke);

  if (newDeviceList.length === 0) {
    return { success: false, error: 'Cannot revoke last device' };
  }

  // Step 4: Build DeviceAnnounce signed with RECOVERY key (not device key)
  const announce = await buildDeviceAnnounce({
    devices: newDeviceList,
    isRevocation: true,
    signingKey: verification.keypair.privateKey,
  });

  // Step 5: Clear recovery keypair from memory
  // (verification.keypair should not be returned or stored)

  return {
    success: true,
    announce,
    newDeviceList,
    revokedDevice: deviceToRevoke,
  };
}

/**
 * Check if user can revoke (has at least 2 devices)
 * @param {Array} devices - Current device list
 * @returns {boolean}
 */
export function canRevokeDevices(devices) {
  return devices && devices.length > 1;
}

/**
 * Get revokable devices (all except current device)
 * @param {Array} devices - Current device list
 * @param {string} currentDeviceUUID - This device's UUID
 * @returns {Array}
 */
export function getRevokableDevices(devices, currentDeviceUUID) {
  return devices.filter(d => d.deviceUUID !== currentDeviceUUID);
}
