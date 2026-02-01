/**
 * Login Flow with Scenario Detection
 * Per identity.md spec: Shell login → check local device → device login
 */

import { LoginScenario, detectScenario } from './scenarios.js';
import { generateDeviceUUID, generateDeviceUsername } from '../crypto/uuid.js';
import { KeyHelper } from '@privacyresearch/libsignal-protocol-typescript';
import { formatSignalKeysForServer } from './register.js';

/**
 * Perform login and detect scenario
 * Per identity.md: Login flow with shell + device check
 *
 * @param {object} client - API client instance
 * @param {string} username - Core username (shell account)
 * @param {string} password - Password
 * @param {object} deviceStore - Device store for local lookup
 * @returns {Promise<object>} Login result with scenario
 */
export async function login(client, username, password, deviceStore) {
  // Step 1: Try shell login
  let shellLoginSuccess = false;
  let shellLoginStatus = 0;
  let shellToken = null;

  try {
    const shellResult = await client.login(username, password);
    shellLoginSuccess = true;
    shellToken = shellResult.token;
  } catch (err) {
    shellLoginStatus = err.status || 0;
    shellLoginSuccess = false;
  }

  // Step 2: Check local device storage
  let storedIdentity = null;
  try {
    storedIdentity = await deviceStore.getIdentity(username);
  } catch (err) {
    // No local identity - that's fine, means NEW_DEVICE
    storedIdentity = null;
  }

  const storedDeviceUsername = storedIdentity?.deviceUsername || null;

  // Step 3: If shell succeeded and we have local device, try device login
  let deviceLoginSuccess = false;
  let deviceToken = null;
  let deviceResult = null;

  if (shellLoginSuccess && storedDeviceUsername) {
    try {
      deviceResult = await client.login(storedDeviceUsername, password);
      deviceLoginSuccess = true;
      deviceToken = deviceResult.token;
    } catch (err) {
      deviceLoginSuccess = false;
    }
  }

  // Detect scenario
  const scenario = detectScenario({
    shellLoginSuccess,
    shellLoginStatus,
    storedDeviceUsername,
    deviceLoginSuccess,
  });

  // Build result based on scenario
  const result = {
    scenario,
    coreUsername: username,
  };

  switch (scenario) {
    case LoginScenario.EXISTING_DEVICE:
      // Success! Use device token
      client.setToken(deviceToken);
      result.success = true;
      result.deviceUsername = storedDeviceUsername;
      result.token = deviceToken;
      result.refreshToken = deviceResult.refreshToken;
      result.expiresAt = deviceResult.expiresAt;
      result.identity = storedIdentity;
      break;

    case LoginScenario.NEW_DEVICE:
      // Need to register new device and show link flow
      result.success = false;
      result.needsLink = true;
      result.shellToken = shellToken;
      break;

    case LoginScenario.LOCAL_DEVICE_MISMATCH:
      // Local data doesn't match server - need to clear and re-link
      result.success = false;
      result.needsClear = true;
      result.shellToken = shellToken;
      break;

    case LoginScenario.INVALID_CREDENTIALS:
    case LoginScenario.USER_NOT_FOUND:
    default:
      result.success = false;
      result.needsRegister = scenario === LoginScenario.USER_NOT_FOUND;
      break;
  }

  return result;
}

/**
 * Register a new device for an existing account (after shell login succeeds)
 * Per identity.md: New device flow
 *
 * @param {object} client - API client instance
 * @param {string} coreUsername - Core username (shell account)
 * @param {string} password - Password
 * @returns {Promise<object>} New device registration data
 */
export async function registerNewDevice(client, coreUsername, password) {
  // Generate device UUID
  const deviceUUID = generateDeviceUUID();
  const deviceUsername = generateDeviceUsername();

  // Generate Signal keys for this device
  const identityKeyPair = await KeyHelper.generateIdentityKeyPair();
  const registrationId = KeyHelper.generateRegistrationId();
  const signedPreKey = await KeyHelper.generateSignedPreKey(identityKeyPair, 1);

  const preKeys = [];
  for (let i = 1; i <= 100; i++) {
    const preKey = await KeyHelper.generatePreKey(i);
    preKeys.push(preKey);
  }

  const signal = {
    identityKeyPair,
    registrationId,
    signedPreKey,
    preKeys,
  };

  // Register device account with server
  const signalKeys = formatSignalKeysForServer(signal);
  const deviceResult = await client.registerDevice({
    username: deviceUsername,
    password,
    ...signalKeys,
  });

  // Set token for subsequent API calls
  client.setToken(deviceResult.token);

  return {
    deviceUUID,
    deviceUsername,
    signal,
    token: deviceResult.token,
    refreshToken: deviceResult.refreshToken,
    expiresAt: deviceResult.expiresAt,
    // This device is pending link approval - no P2P identity yet
    linkPending: true,
  };
}

/**
 * Clear local device data (for mismatch recovery)
 * @param {object} deviceStore - Device store
 * @param {string} coreUsername - Core username to clear
 */
export async function clearLocalDevice(deviceStore, coreUsername) {
  await deviceStore.deleteIdentity(coreUsername);
}
