// IndexedDB-backed SignalProtocolStore for libsignal
// Implements the StorageType interface required by @privacyresearch/libsignal-protocol-typescript

import { Direction } from '@privacyresearch/libsignal-protocol-typescript';

const DB_NAME = 'obscura_signal_store';
const DB_VERSION = 1;

const STORES = {
  IDENTITY_KEYS: 'identityKeys',
  TRUSTED_IDENTITIES: 'trustedIdentities',
  PRE_KEYS: 'preKeys',
  SIGNED_PRE_KEYS: 'signedPreKeys',
  SESSIONS: 'sessions',
};

class SignalProtocolStore {
  constructor() {
    this.db = null;
  }

  async open() {
    if (this.db) return this.db;

    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = (event) => {
        const db = event.target.result;

        // Create object stores if they don't exist
        if (!db.objectStoreNames.contains(STORES.IDENTITY_KEYS)) {
          db.createObjectStore(STORES.IDENTITY_KEYS);
        }
        if (!db.objectStoreNames.contains(STORES.TRUSTED_IDENTITIES)) {
          db.createObjectStore(STORES.TRUSTED_IDENTITIES);
        }
        if (!db.objectStoreNames.contains(STORES.PRE_KEYS)) {
          db.createObjectStore(STORES.PRE_KEYS);
        }
        if (!db.objectStoreNames.contains(STORES.SIGNED_PRE_KEYS)) {
          db.createObjectStore(STORES.SIGNED_PRE_KEYS);
        }
        if (!db.objectStoreNames.contains(STORES.SESSIONS)) {
          db.createObjectStore(STORES.SESSIONS);
        }
      };

      request.onsuccess = (event) => {
        this.db = event.target.result;
        resolve(this.db);
      };

      request.onerror = (event) => {
        reject(event.target.error);
      };
    });
  }

  // Helper to get a value from a store
  async _get(storeName, key) {
    await this.open();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(storeName, 'readonly');
      const store = tx.objectStore(storeName);
      const request = store.get(key);

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  // Helper to put a value in a store
  async _put(storeName, key, value) {
    await this.open();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      store.put(value, key);

      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  // Helper to delete a value from a store
  async _delete(storeName, key) {
    await this.open();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      store.delete(key);

      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  // === Identity Key Methods ===

  async getIdentityKeyPair() {
    const data = await this._get(STORES.IDENTITY_KEYS, 'local');
    if (!data) return undefined;
    return {
      pubKey: data.pubKey,
      privKey: data.privKey,
    };
  }

  async storeIdentityKeyPair(keyPair) {
    await this._put(STORES.IDENTITY_KEYS, 'local', {
      pubKey: keyPair.pubKey,
      privKey: keyPair.privKey,
    });
  }

  async getLocalRegistrationId() {
    const data = await this._get(STORES.IDENTITY_KEYS, 'registrationId');
    return data;
  }

  async storeLocalRegistrationId(registrationId) {
    await this._put(STORES.IDENTITY_KEYS, 'registrationId', registrationId);
  }

  // Check if an identity is trusted
  // For now, we trust on first use (TOFU) and warn on change
  async isTrustedIdentity(identifier, identityKey, direction) {
    const stored = await this._get(STORES.TRUSTED_IDENTITIES, identifier);

    if (!stored) {
      // First time seeing this identity - trust it
      return true;
    }

    // Compare the stored key with the provided key
    const storedKeyArray = new Uint8Array(stored.publicKey);
    const providedKeyArray = new Uint8Array(identityKey);

    if (storedKeyArray.length !== providedKeyArray.length) {
      return false;
    }

    for (let i = 0; i < storedKeyArray.length; i++) {
      if (storedKeyArray[i] !== providedKeyArray[i]) {
        // Key has changed - this could be a MITM attack or key rotation
        console.warn(`Identity key changed for ${identifier}`);
        return stored.trusted === true; // Only trust if explicitly marked trusted
      }
    }

    return true;
  }

  // Save an identity key for a remote user
  // Returns true if the key is new/different (triggers identity change warning)
  async saveIdentity(encodedAddress, publicKey, nonblockingApproval = false) {
    const existing = await this._get(STORES.TRUSTED_IDENTITIES, encodedAddress);

    const isNew = !existing;
    let keyChanged = false;

    if (existing) {
      const existingArray = new Uint8Array(existing.publicKey);
      const newArray = new Uint8Array(publicKey);

      if (existingArray.length !== newArray.length) {
        keyChanged = true;
      } else {
        for (let i = 0; i < existingArray.length; i++) {
          if (existingArray[i] !== newArray[i]) {
            keyChanged = true;
            break;
          }
        }
      }
    }

    await this._put(STORES.TRUSTED_IDENTITIES, encodedAddress, {
      publicKey: publicKey,
      trusted: true,
      firstSeen: existing?.firstSeen || Date.now(),
      lastSeen: Date.now(),
    });

    return keyChanged;
  }

  // === Pre-Key Methods ===

  async loadPreKey(keyId) {
    const data = await this._get(STORES.PRE_KEYS, keyId.toString());
    if (!data) return undefined;
    return {
      pubKey: data.pubKey,
      privKey: data.privKey,
    };
  }

  async storePreKey(keyId, keyPair) {
    await this._put(STORES.PRE_KEYS, keyId.toString(), {
      pubKey: keyPair.pubKey,
      privKey: keyPair.privKey,
    });
  }

  async removePreKey(keyId) {
    await this._delete(STORES.PRE_KEYS, keyId.toString());
  }

  // === Signed Pre-Key Methods ===

  async loadSignedPreKey(keyId) {
    const data = await this._get(STORES.SIGNED_PRE_KEYS, keyId.toString());
    if (!data) return undefined;
    return {
      pubKey: data.pubKey,
      privKey: data.privKey,
    };
  }

  async storeSignedPreKey(keyId, keyPair) {
    await this._put(STORES.SIGNED_PRE_KEYS, keyId.toString(), {
      pubKey: keyPair.pubKey,
      privKey: keyPair.privKey,
    });
  }

  async removeSignedPreKey(keyId) {
    await this._delete(STORES.SIGNED_PRE_KEYS, keyId.toString());
  }

  // === Session Methods ===

  async loadSession(encodedAddress) {
    const data = await this._get(STORES.SESSIONS, encodedAddress);
    return data; // SessionRecordType is a string
  }

  async storeSession(encodedAddress, record) {
    await this._put(STORES.SESSIONS, encodedAddress, record);
  }

  async removeSession(encodedAddress) {
    await this._delete(STORES.SESSIONS, encodedAddress);
  }

  // === Pre-Key Management ===

  async getPreKeyCount() {
    await this.open();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(STORES.PRE_KEYS, 'readonly');
      const store = tx.objectStore(STORES.PRE_KEYS);
      const request = store.count();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async getHighestPreKeyId() {
    await this.open();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(STORES.PRE_KEYS, 'readonly');
      const store = tx.objectStore(STORES.PRE_KEYS);
      const request = store.getAllKeys();
      request.onsuccess = () => {
        const keys = request.result.map(k => parseInt(k, 10));
        resolve(keys.length > 0 ? Math.max(...keys) : 0);
      };
      request.onerror = () => reject(request.error);
    });
  }

  async getHighestSignedPreKeyId() {
    await this.open();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(STORES.SIGNED_PRE_KEYS, 'readonly');
      const store = tx.objectStore(STORES.SIGNED_PRE_KEYS);
      const request = store.getAllKeys();
      request.onsuccess = () => {
        const keys = request.result.map(k => parseInt(k, 10));
        resolve(keys.length > 0 ? Math.max(...keys) : 0);
      };
      request.onerror = () => reject(request.error);
    });
  }

  // === Utility Methods ===

  async clearAll() {
    await this.open();
    return new Promise((resolve, reject) => {
      const storeNames = Object.values(STORES);
      const tx = this.db.transaction(storeNames, 'readwrite');

      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);

      for (const storeName of storeNames) {
        tx.objectStore(storeName).clear();
      }
    });
  }

  async hasIdentity() {
    const keyPair = await this.getIdentityKeyPair();
    return keyPair !== undefined;
  }
}

// Singleton instance
export const signalStore = new SignalProtocolStore();
export default signalStore;
