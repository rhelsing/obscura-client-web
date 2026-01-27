/**
 * Login Scenarios
 * Per identity.md spec: Detect login outcome based on shell + device login results
 */

export const LoginScenario = {
  /** Shell login failed - invalid username or password */
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',

  /** Shell login OK, device login OK - existing device, continue to app */
  EXISTING_DEVICE: 'EXISTING_DEVICE',

  /** Shell login OK, no local device stored - new device, show link flow */
  NEW_DEVICE: 'NEW_DEVICE',

  /** Shell login OK, local device stored but device login failed - mismatch */
  LOCAL_DEVICE_MISMATCH: 'LOCAL_DEVICE_MISMATCH',

  /** User doesn't exist - prompt to register */
  USER_NOT_FOUND: 'USER_NOT_FOUND',
};

/**
 * Determine login scenario from results
 * @param {object} params
 * @param {boolean} params.shellLoginSuccess - Did shell login succeed?
 * @param {number} params.shellLoginStatus - HTTP status from shell login
 * @param {string|null} params.storedDeviceUsername - Device username from local storage
 * @param {boolean} params.deviceLoginSuccess - Did device login succeed? (only if storedDeviceUsername exists)
 * @returns {string} LoginScenario value
 */
export function detectScenario({ shellLoginSuccess, shellLoginStatus, storedDeviceUsername, deviceLoginSuccess }) {
  // Shell login failed
  if (!shellLoginSuccess) {
    if (shellLoginStatus === 404) {
      return LoginScenario.USER_NOT_FOUND;
    }
    return LoginScenario.INVALID_CREDENTIALS;
  }

  // Shell login succeeded - check device
  if (!storedDeviceUsername) {
    // No local device stored - this is a new device
    return LoginScenario.NEW_DEVICE;
  }

  // Local device exists - check if device login works
  if (deviceLoginSuccess) {
    return LoginScenario.EXISTING_DEVICE;
  }

  // Device login failed but we have local data - mismatch
  return LoginScenario.LOCAL_DEVICE_MISMATCH;
}

/**
 * Get human-readable message for scenario
 * @param {string} scenario - LoginScenario value
 * @returns {string}
 */
export function getScenarioMessage(scenario) {
  switch (scenario) {
    case LoginScenario.INVALID_CREDENTIALS:
      return 'Invalid username or password';
    case LoginScenario.USER_NOT_FOUND:
      return 'Account not found. Please register.';
    case LoginScenario.EXISTING_DEVICE:
      return 'Welcome back!';
    case LoginScenario.NEW_DEVICE:
      return 'New device detected. Link with existing device to continue.';
    case LoginScenario.LOCAL_DEVICE_MISMATCH:
      return 'Device mismatch. Please clear local data and re-link.';
    default:
      return 'Unknown scenario';
  }
}
