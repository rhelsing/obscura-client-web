/**
 * Backup Manager
 * Handles full account backup export and import
 *
 * Export: Collects all data from IndexedDB stores, encrypts with recoveryPublicKey
 * Import: Decrypts with recovery phrase, restores all data to IndexedDB stores
 */

import { encryptBackup, decryptBackup, verifyRecoveryPhrase } from '../crypto/backup.js';
import { IndexedDBStore } from '../lib/IndexedDBStore.js';
import { createDeviceStore } from '../store/deviceStore.js';
import { createFriendStore } from '../store/friendStore.js';
import { createMessageStore } from '../store/messageStore.js';
import { keyCache } from '../lib/keyCache.js';

const BACKUP_MAGIC = 'OBSCURA_BACKUP';
const BACKUP_FILE_VERSION = 1;

/**
 * Create a backup manager for a user
 * @param {string} username - Core username
 * @param {string} userId - Server user ID
 * @returns {object} Backup manager instance
 */
export function createBackupManager(username, userId) {
  const signalStore = new IndexedDBStore(username);
  const deviceStore = createDeviceStore(username);
  const friendStore = createFriendStore(userId);
  const messageStore = createMessageStore(username);

  return {
    /**
     * Export all account data as encrypted backup
     * No recovery phrase needed - uses stored recoveryPublicKey
     *
     * @returns {Promise<{blob: Blob, filename: string}>} Encrypted backup file
     * @throws {Error} If recoveryPublicKey not found
     */
    async exportBackup() {
      // 1. Get recovery public key from device store
      const identity = await deviceStore.getIdentity();
      if (!identity?.recoveryPublicKey) {
        throw new Error('Recovery public key not found. Cannot create backup.');
      }

      const recoveryPublicKey = identity.recoveryPublicKey instanceof Uint8Array
        ? identity.recoveryPublicKey
        : new Uint8Array(Object.values(identity.recoveryPublicKey));

      // 2. Collect all data
      const backupData = await this._collectAllData(identity);

      // 3. Encrypt with recovery public key
      const encryptedData = await encryptBackup(backupData, recoveryPublicKey);

      // 4. Create file header
      // Format: MAGIC (14 bytes) + version (1 byte) + encrypted data
      const magicBytes = new TextEncoder().encode(BACKUP_MAGIC);
      const fileData = new Uint8Array(magicBytes.length + 1 + encryptedData.length);
      fileData.set(magicBytes);
      fileData[magicBytes.length] = BACKUP_FILE_VERSION;
      fileData.set(encryptedData, magicBytes.length + 1);

      // 5. Create blob and filename
      const blob = new Blob([fileData], { type: 'application/octet-stream' });
      const date = new Date().toISOString().split('T')[0];
      const filename = `obscura-backup-${username}-${date}.obscura`;

      return { blob, filename };
    },

    /**
     * Collect all data from IndexedDB stores
     * @private
     */
    async _collectAllData(deviceIdentity) {
      // Signal store data
      await signalStore.open();
      const signalIdentity = await signalStore.loadIdentityRecord();
      const deviceSignalIdentity = await signalStore.getDeviceIdentity();

      // Collect prekeys
      const preKeys = [];
      const preKeyCount = await signalStore.getPreKeyCount();
      // We'll export prekeys by iterating (IndexedDB doesn't have getAll on store directly for this)
      // For now, we'll skip prekeys in backup - they're ephemeral and can be regenerated

      // Collect signed prekeys
      const signedPreKeyId = await signalStore.getHighestSignedPreKeyId();
      const signedPreKey = signedPreKeyId > 0 ? await signalStore.loadSignedPreKey(signedPreKeyId) : null;

      // Get identity keypair from cache (it's encrypted at rest)
      const identityKeyPair = keyCache.getIdentityKeyPair();
      const registrationId = keyCache.getRegistrationId();

      // Device store data
      const ownDevices = await deviceStore.getOwnDevices();

      // Friend store data
      const friendData = await friendStore.exportAll();

      // Message store data
      const messages = await messageStore.exportAll();
      console.log('[BackupManager] Exporting messages:', {
        count: messages.length,
        messageIds: messages.map(m => m.messageId).slice(0, 5),
      });

      return {
        version: 1,
        exportedAt: Date.now(),
        username: deviceIdentity.coreUsername,

        // Device identity (p2p keys, recovery public key)
        deviceIdentity: {
          coreUsername: deviceIdentity.coreUsername,
          deviceUUID: deviceIdentity.deviceUUID,
          p2pPublicKey: deviceIdentity.p2pPublicKey,
          p2pPrivateKey: deviceIdentity.p2pPrivateKey,
          recoveryPublicKey: deviceIdentity.recoveryPublicKey,
        },

        // Signal identity (encrypted keys)
        signalIdentity: {
          // Export the encrypted identity if available, otherwise the raw
          salt: signalIdentity?.salt,
          iv: signalIdentity?.iv,
          ciphertext: signalIdentity?.ciphertext,
          registrationId: signalIdentity?.registrationId || registrationId,
          // Also include unencrypted if available (for migration)
          keyPair: signalIdentity?.keyPair,
        },

        // Device signal identity
        deviceSignalIdentity,

        // Signed prekey (latest)
        signedPreKey: signedPreKey ? {
          keyId: signedPreKeyId,
          keyPair: signedPreKey,
        } : null,

        // Own devices list
        ownDevices,

        // Friends and pending messages
        friends: friendData.friends,
        pendingMessages: friendData.pendingMessages,

        // Message history
        messages,
      };
    },

    /**
     * Import backup from encrypted file
     * Requires recovery phrase to decrypt
     *
     * @param {Uint8Array|ArrayBuffer} fileData - Raw backup file data
     * @param {string} recoveryPhrase - 12-word BIP39 recovery phrase
     * @param {string} password - User's password (for re-encrypting keys at rest)
     * @returns {Promise<object>} Import result { username, deviceCount, friendCount, messageCount }
     * @throws {Error} If file is invalid or phrase is wrong
     */
    async importBackup(fileData, recoveryPhrase, password) {
      const bytes = fileData instanceof ArrayBuffer ? new Uint8Array(fileData) : fileData;

      // 1. Validate file header
      const magicBytes = new TextEncoder().encode(BACKUP_MAGIC);
      const fileMagic = new TextDecoder().decode(bytes.slice(0, magicBytes.length));
      if (fileMagic !== BACKUP_MAGIC) {
        throw new Error('Invalid backup file format');
      }

      const fileVersion = bytes[magicBytes.length];
      if (fileVersion !== BACKUP_FILE_VERSION) {
        throw new Error(`Unsupported backup file version: ${fileVersion}`);
      }

      // 2. Extract encrypted data
      const encryptedData = bytes.slice(magicBytes.length + 1);

      // 3. Decrypt with recovery phrase
      const backupData = await decryptBackup(encryptedData, recoveryPhrase);

      // 4. Restore all data
      await this._restoreAllData(backupData, password);

      return {
        username: backupData.username,
        deviceCount: backupData.ownDevices?.length || 0,
        friendCount: backupData.friends?.length || 0,
        messageCount: backupData.messages?.length || 0,
      };
    },

    /**
     * Restore all data to IndexedDB stores
     * @private
     */
    async _restoreAllData(backupData, password) {
      const { encryptKeys } = await import('../crypto/keyEncryption.js');

      // 1. Restore device identity
      if (backupData.deviceIdentity) {
        await deviceStore.storeIdentity(backupData.deviceIdentity);
      }

      // 2. Restore own devices
      if (backupData.ownDevices) {
        await deviceStore.setOwnDevices(backupData.ownDevices);
      }

      // 3. Restore Signal identity
      await signalStore.open();

      if (backupData.signalIdentity) {
        const signalId = backupData.signalIdentity;

        // If we have encrypted data, store it directly
        if (signalId.ciphertext && signalId.salt && signalId.iv) {
          await signalStore.storeEncryptedIdentity({
            salt: signalId.salt instanceof Uint8Array ? signalId.salt : new Uint8Array(Object.values(signalId.salt)),
            iv: signalId.iv instanceof Uint8Array ? signalId.iv : new Uint8Array(Object.values(signalId.iv)),
            ciphertext: signalId.ciphertext instanceof Uint8Array ? signalId.ciphertext : new Uint8Array(Object.values(signalId.ciphertext)),
            registrationId: signalId.registrationId,
          });
        }
        // If we have unencrypted keyPair, encrypt it with the new password
        else if (signalId.keyPair) {
          const encrypted = await encryptKeys({
            identityKeyPair: signalId.keyPair,
          }, password);
          await signalStore.storeEncryptedIdentity({
            ...encrypted,
            registrationId: signalId.registrationId,
          });
        }
      }

      // 4. Restore device signal identity
      if (backupData.deviceSignalIdentity) {
        await signalStore.storeDeviceIdentity(backupData.deviceSignalIdentity);
      }

      // 5. Restore signed prekey
      if (backupData.signedPreKey) {
        await signalStore.storeSignedPreKey(backupData.signedPreKey.keyId, backupData.signedPreKey.keyPair);
      }

      // 6. Restore friends
      if (backupData.friends || backupData.pendingMessages) {
        await friendStore.importAll({
          friends: backupData.friends,
          pendingMessages: backupData.pendingMessages,
        });
      }

      // 7. Restore messages
      if (backupData.messages) {
        await messageStore.importMessages(backupData.messages);
      }
    },

    /**
     * Validate a backup file without importing
     * Returns metadata about the backup
     *
     * @param {Uint8Array|ArrayBuffer} fileData - Raw backup file data
     * @param {string} recoveryPhrase - 12-word recovery phrase
     * @returns {Promise<object>} Backup metadata
     */
    async validateBackup(fileData, recoveryPhrase) {
      const bytes = fileData instanceof ArrayBuffer ? new Uint8Array(fileData) : fileData;

      // Validate header
      const magicBytes = new TextEncoder().encode(BACKUP_MAGIC);
      const fileMagic = new TextDecoder().decode(bytes.slice(0, magicBytes.length));
      if (fileMagic !== BACKUP_MAGIC) {
        throw new Error('Invalid backup file format');
      }

      const fileVersion = bytes[magicBytes.length];
      if (fileVersion !== BACKUP_FILE_VERSION) {
        throw new Error(`Unsupported backup file version: ${fileVersion}`);
      }

      // Decrypt and return metadata
      const encryptedData = bytes.slice(magicBytes.length + 1);
      const backupData = await decryptBackup(encryptedData, recoveryPhrase);

      return {
        version: backupData.version,
        username: backupData.username,
        exportedAt: new Date(backupData.exportedAt),
        deviceCount: backupData.ownDevices?.length || 0,
        friendCount: backupData.friends?.length || 0,
        messageCount: backupData.messages?.length || 0,
      };
    },

    /**
     * Close all store connections
     */
    close() {
      signalStore.close();
      deviceStore.close();
      friendStore.close();
      messageStore.close();
    },
  };
}

export default createBackupManager;
