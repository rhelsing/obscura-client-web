/**
 * Pluggable Signal Store Interface
 * Supports in-memory (tests) or IndexedDB (browser)
 */

export class InMemoryStore {
  constructor() {
    this.identityKeyPair = null;
    this.registrationId = null;
    this.preKeys = new Map();
    this.signedPreKeys = new Map();
    this.sessions = new Map();
    this.trustedIdentities = new Map();

    // Device identity (stored locally)
    this.deviceUsername = null;
    this.deviceUUID = null;
    this.coreUsername = null;
  }

  // === Signal Protocol Store Interface ===

  async getIdentityKeyPair() {
    return this.identityKeyPair;
  }

  async storeIdentityKeyPair(keyPair) {
    this.identityKeyPair = keyPair;
  }

  async getLocalRegistrationId() {
    return this.registrationId;
  }

  async storeLocalRegistrationId(registrationId) {
    this.registrationId = registrationId;
  }

  async isTrustedIdentity(identifier, identityKey, direction) {
    const stored = this.trustedIdentities.get(identifier);
    if (!stored) return true; // TOFU (Trust On First Use)

    const storedArray = new Uint8Array(stored.publicKey);
    const providedArray = new Uint8Array(identityKey);

    if (storedArray.length !== providedArray.length) return false;
    for (let i = 0; i < storedArray.length; i++) {
      if (storedArray[i] !== providedArray[i]) return false;
    }
    return true;
  }

  async saveIdentity(encodedAddress, publicKey) {
    const existing = this.trustedIdentities.get(encodedAddress);
    this.trustedIdentities.set(encodedAddress, {
      publicKey,
      trusted: true,
      firstSeen: existing?.firstSeen || Date.now(),
      lastSeen: Date.now(),
    });
    return !!existing;
  }

  async loadPreKey(keyId) {
    return this.preKeys.get(keyId.toString());
  }

  async storePreKey(keyId, keyPair) {
    this.preKeys.set(keyId.toString(), keyPair);
  }

  async removePreKey(keyId) {
    this.preKeys.delete(keyId.toString());
  }

  async loadSignedPreKey(keyId) {
    return this.signedPreKeys.get(keyId.toString());
  }

  async storeSignedPreKey(keyId, keyPair) {
    this.signedPreKeys.set(keyId.toString(), keyPair);
  }

  async removeSignedPreKey(keyId) {
    this.signedPreKeys.delete(keyId.toString());
  }

  async loadSession(encodedAddress) {
    return this.sessions.get(encodedAddress);
  }

  async storeSession(encodedAddress, record) {
    this.sessions.set(encodedAddress, record);
  }

  async removeSession(encodedAddress) {
    this.sessions.delete(encodedAddress);
  }

  // === Device Identity Storage ===

  async getDeviceIdentity() {
    if (!this.deviceUsername) return null;
    return {
      deviceUsername: this.deviceUsername,
      deviceUUID: this.deviceUUID,
      coreUsername: this.coreUsername,
    };
  }

  async storeDeviceIdentity({ deviceUsername, deviceUUID, coreUsername }) {
    this.deviceUsername = deviceUsername;
    this.deviceUUID = deviceUUID;
    this.coreUsername = coreUsername;
  }

  async clearDeviceIdentity() {
    this.deviceUsername = null;
    this.deviceUUID = null;
    this.coreUsername = null;
  }

  // === Helpers ===

  async hasIdentity() {
    return this.identityKeyPair !== null;
  }

  async clearAll() {
    this.identityKeyPair = null;
    this.registrationId = null;
    this.preKeys.clear();
    this.signedPreKeys.clear();
    this.sessions.clear();
    this.trustedIdentities.clear();
    this.deviceUsername = null;
    this.deviceUUID = null;
    this.coreUsername = null;
  }

  getPreKeyCount() {
    return this.preKeys.size;
  }

  getHighestPreKeyId() {
    const ids = Array.from(this.preKeys.keys()).map(k => parseInt(k, 10));
    return ids.length > 0 ? Math.max(...ids) : 0;
  }

  getHighestSignedPreKeyId() {
    const ids = Array.from(this.signedPreKeys.keys()).map(k => parseInt(k, 10));
    return ids.length > 0 ? Math.max(...ids) : 0;
  }
}
