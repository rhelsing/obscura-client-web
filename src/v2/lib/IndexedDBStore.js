/**
 * IndexedDB Signal Store
 * Same interface as InMemoryStore, but persists to IndexedDB
 */

const DB_NAME_PREFIX = 'obscura_signal_v2';
const DB_VERSION = 1;

const STORES = {
  IDENTITY: 'identity',
  PRE_KEYS: 'preKeys',
  SIGNED_PRE_KEYS: 'signedPreKeys',
  SESSIONS: 'sessions',
  TRUSTED_IDENTITIES: 'trustedIdentities',
  DEVICE_IDENTITY: 'deviceIdentity',
};

export class IndexedDBStore {
  constructor(namespace = 'default') {
    this.namespace = namespace;
    this.dbName = `${DB_NAME_PREFIX}_${namespace}`;
    this.db = null;
  }

  /**
   * Open or create the database
   */
  async open() {
    if (this.db) return this.db;

    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, DB_VERSION);

      request.onerror = () => reject(request.error);

      request.onsuccess = () => {
        this.db = request.result;
        resolve(this.db);
      };

      request.onupgradeneeded = (event) => {
        const database = event.target.result;

        // Identity keypair + registrationId (singleton)
        if (!database.objectStoreNames.contains(STORES.IDENTITY)) {
          database.createObjectStore(STORES.IDENTITY, { keyPath: 'id' });
        }

        // PreKeys (keyId -> keypair)
        if (!database.objectStoreNames.contains(STORES.PRE_KEYS)) {
          database.createObjectStore(STORES.PRE_KEYS, { keyPath: 'keyId' });
        }

        // Signed PreKeys (keyId -> keypair)
        if (!database.objectStoreNames.contains(STORES.SIGNED_PRE_KEYS)) {
          database.createObjectStore(STORES.SIGNED_PRE_KEYS, { keyPath: 'keyId' });
        }

        // Sessions (address -> record)
        if (!database.objectStoreNames.contains(STORES.SESSIONS)) {
          database.createObjectStore(STORES.SESSIONS, { keyPath: 'address' });
        }

        // Trusted identities (identifier -> publicKey)
        if (!database.objectStoreNames.contains(STORES.TRUSTED_IDENTITIES)) {
          database.createObjectStore(STORES.TRUSTED_IDENTITIES, { keyPath: 'identifier' });
        }

        // Device identity (singleton)
        if (!database.objectStoreNames.contains(STORES.DEVICE_IDENTITY)) {
          database.createObjectStore(STORES.DEVICE_IDENTITY, { keyPath: 'id' });
        }
      };
    });
  }

  /**
   * Close the database
   */
  close() {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  /**
   * Get a transaction and object store
   */
  async _getStore(storeName, mode = 'readonly') {
    await this.open();
    const tx = this.db.transaction(storeName, mode);
    return tx.objectStore(storeName);
  }

  /**
   * Promise wrapper for IDB request
   */
  _promisify(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  // === Signal Protocol Store Interface ===

  async getIdentityKeyPair() {
    const store = await this._getStore(STORES.IDENTITY);
    const record = await this._promisify(store.get('identity'));
    return record?.keyPair || null;
  }

  async storeIdentityKeyPair(keyPair) {
    const store = await this._getStore(STORES.IDENTITY, 'readwrite');
    const existing = await this._promisify(store.get('identity'));
    await this._promisify(store.put({
      id: 'identity',
      keyPair,
      registrationId: existing?.registrationId,
    }));
  }

  async getLocalRegistrationId() {
    const store = await this._getStore(STORES.IDENTITY);
    const record = await this._promisify(store.get('identity'));
    return record?.registrationId || null;
  }

  async storeLocalRegistrationId(registrationId) {
    const store = await this._getStore(STORES.IDENTITY, 'readwrite');
    const existing = await this._promisify(store.get('identity'));
    await this._promisify(store.put({
      id: 'identity',
      keyPair: existing?.keyPair,
      registrationId,
    }));
  }

  async isTrustedIdentity(identifier, identityKey, direction) {
    const store = await this._getStore(STORES.TRUSTED_IDENTITIES);
    const stored = await this._promisify(store.get(identifier));
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
    const store = await this._getStore(STORES.TRUSTED_IDENTITIES, 'readwrite');
    const existing = await this._promisify(store.get(encodedAddress));
    await this._promisify(store.put({
      identifier: encodedAddress,
      publicKey,
      trusted: true,
      firstSeen: existing?.firstSeen || Date.now(),
      lastSeen: Date.now(),
    }));
    return !!existing;
  }

  async loadPreKey(keyId) {
    const store = await this._getStore(STORES.PRE_KEYS);
    const record = await this._promisify(store.get(keyId.toString()));
    return record?.keyPair || undefined;
  }

  async storePreKey(keyId, keyPair) {
    const store = await this._getStore(STORES.PRE_KEYS, 'readwrite');
    await this._promisify(store.put({
      keyId: keyId.toString(),
      keyPair,
    }));
  }

  async removePreKey(keyId) {
    const store = await this._getStore(STORES.PRE_KEYS, 'readwrite');
    await this._promisify(store.delete(keyId.toString()));
  }

  async loadSignedPreKey(keyId) {
    const store = await this._getStore(STORES.SIGNED_PRE_KEYS);
    const record = await this._promisify(store.get(keyId.toString()));
    return record?.keyPair || undefined;
  }

  async storeSignedPreKey(keyId, keyPair) {
    const store = await this._getStore(STORES.SIGNED_PRE_KEYS, 'readwrite');
    await this._promisify(store.put({
      keyId: keyId.toString(),
      keyPair,
    }));
  }

  async removeSignedPreKey(keyId) {
    const store = await this._getStore(STORES.SIGNED_PRE_KEYS, 'readwrite');
    await this._promisify(store.delete(keyId.toString()));
  }

  async loadSession(encodedAddress) {
    const store = await this._getStore(STORES.SESSIONS);
    const record = await this._promisify(store.get(encodedAddress));
    return record?.record || undefined;
  }

  async storeSession(encodedAddress, record) {
    const store = await this._getStore(STORES.SESSIONS, 'readwrite');
    await this._promisify(store.put({
      address: encodedAddress,
      record,
    }));
  }

  async removeSession(encodedAddress) {
    const store = await this._getStore(STORES.SESSIONS, 'readwrite');
    await this._promisify(store.delete(encodedAddress));
  }

  // === Device Identity Storage ===

  async getDeviceIdentity() {
    const store = await this._getStore(STORES.DEVICE_IDENTITY);
    const record = await this._promisify(store.get('current'));
    if (!record) return null;
    return {
      deviceUsername: record.deviceUsername,
      deviceUUID: record.deviceUUID,
      coreUsername: record.coreUsername,
      isFirstDevice: record.isFirstDevice ?? false,
    };
  }

  async storeDeviceIdentity({ deviceUsername, deviceUUID, coreUsername, isFirstDevice }) {
    const store = await this._getStore(STORES.DEVICE_IDENTITY, 'readwrite');
    await this._promisify(store.put({
      id: 'current',
      deviceUsername,
      deviceUUID,
      coreUsername,
      isFirstDevice: isFirstDevice ?? false,
    }));
  }

  async clearDeviceIdentity() {
    const store = await this._getStore(STORES.DEVICE_IDENTITY, 'readwrite');
    await this._promisify(store.delete('current'));
  }

  // === Helpers ===

  async hasIdentity() {
    const keyPair = await this.getIdentityKeyPair();
    return keyPair !== null;
  }

  async clearAll() {
    const storeNames = Object.values(STORES);
    for (const storeName of storeNames) {
      const store = await this._getStore(storeName, 'readwrite');
      await this._promisify(store.clear());
    }
  }

  async getPreKeyCount() {
    const store = await this._getStore(STORES.PRE_KEYS);
    return this._promisify(store.count());
  }

  async getHighestPreKeyId() {
    const store = await this._getStore(STORES.PRE_KEYS);
    const all = await this._promisify(store.getAll());
    const ids = all.map(r => parseInt(r.keyId, 10));
    return ids.length > 0 ? Math.max(...ids) : 0;
  }

  async getHighestSignedPreKeyId() {
    const store = await this._getStore(STORES.SIGNED_PRE_KEYS);
    const all = await this._promisify(store.getAll());
    const ids = all.map(r => parseInt(r.keyId, 10));
    return ids.length > 0 ? Math.max(...ids) : 0;
  }
}
