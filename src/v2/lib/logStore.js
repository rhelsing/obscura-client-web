// IndexedDB-backed log store for message debugging
// Stores all send/receive/encrypt/decrypt events per device

const DB_NAME_PREFIX = 'obscura_logs';
const DB_VERSION = 1;

const STORES = {
  EVENTS: 'events',
};

// Event types for logging
export const LogEventType = {
  // Send flow
  SEND_START: 'send_start',
  SEND_ENCRYPT_START: 'send_encrypt_start',
  SEND_ENCRYPT_COMPLETE: 'send_encrypt_complete',
  SEND_COMPLETE: 'send_complete',
  SEND_ERROR: 'send_error',

  // Receive flow
  RECEIVE_ENVELOPE: 'receive_envelope',
  RECEIVE_DECRYPT_START: 'receive_decrypt_start',
  RECEIVE_DECRYPT_COMPLETE: 'receive_decrypt_complete',
  RECEIVE_DECODE: 'receive_decode',
  RECEIVE_COMPLETE: 'receive_complete',
  RECEIVE_ERROR: 'receive_error',

  // Critical errors
  MESSAGE_LOST: 'message_lost', // Decrypt succeeded but processing failed - message unrecoverable

  // Session events
  SESSION_ESTABLISH: 'session_establish',
  SESSION_RESET: 'session_reset',

  // Gateway events
  GATEWAY_CONNECT: 'gateway_connect',
  GATEWAY_DISCONNECT: 'gateway_disconnect',
  GATEWAY_ACK: 'gateway_ack',

  // Keys & Crypto
  PREKEY_FETCH: 'prekey_fetch',
  PREKEY_FETCH_ERROR: 'prekey_fetch_error',
  PREKEY_REPLENISH: 'prekey_replenish',
  PREKEY_REPLENISH_ERROR: 'prekey_replenish_error',
  ENCRYPT_ERROR: 'encrypt_error',
  DECRYPT_ERROR: 'decrypt_error',

  // Friends
  FRIEND_REQUEST_SENT: 'friend_request_sent',
  FRIEND_REQUEST_RECEIVED: 'friend_request_received',
  FRIEND_ACCEPT: 'friend_accept',
  FRIEND_REJECT: 'friend_reject',
  FRIEND_REMOVE: 'friend_remove',

  // Devices
  DEVICE_ADD: 'device_add',
  DEVICE_REMOVE: 'device_remove',
  DEVICE_LINK_START: 'device_link_start',
  DEVICE_LINK_APPROVE: 'device_link_approve',
  DEVICE_ANNOUNCE: 'device_announce',
  DEVICE_REVOKE: 'device_revoke',

  // Attachments
  ATTACHMENT_UPLOAD: 'attachment_upload',
  ATTACHMENT_UPLOAD_ERROR: 'attachment_upload_error',
  ATTACHMENT_DOWNLOAD: 'attachment_download',
  ATTACHMENT_DOWNLOAD_ERROR: 'attachment_download_error',
  ATTACHMENT_CACHE_HIT: 'attachment_cache_hit',

  // Storage
  STORAGE_ERROR: 'storage_error',
  MESSAGE_PERSIST: 'message_persist',
  MESSAGE_PERSIST_ERROR: 'message_persist_error',

  // ORM Sync
  ORM_SYNC_SEND: 'orm_sync_send',
  ORM_SYNC_RECEIVE: 'orm_sync_receive',
  ORM_SYNC_ERROR: 'orm_sync_error',
  SYNC_BLOB_SEND: 'sync_blob_send',
  SYNC_BLOB_RECEIVE: 'sync_blob_receive',

  // TTL Cleanup
  TTL_CLEANUP: 'ttl_cleanup',
  TTL_CLEANUP_ERROR: 'ttl_cleanup_error',

  // Auth lifecycle
  TOKEN_REFRESH: 'token_refresh',
  TOKEN_REFRESH_ERROR: 'token_refresh_error',
  SESSION_RESTORE: 'session_restore',
  SESSION_RESTORE_ERROR: 'session_restore_error',
  LOGIN: 'login',
  LOGIN_ERROR: 'login_error',
  LOGOUT: 'logout',

  // Backup
  BACKUP_UPLOAD: 'backup_upload',
  BACKUP_UPLOAD_ERROR: 'backup_upload_error',
  BACKUP_CHECK: 'backup_check',
  BACKUP_CHECK_ERROR: 'backup_check_error',
  BACKUP_DOWNLOAD: 'backup_download',
  BACKUP_DOWNLOAD_ERROR: 'backup_download_error',
};

class LogStore {
  constructor() {
    this.db = null;
    this.deviceId = null;
    this.dbName = null;
  }

  // Initialize store for a specific device - must be called before any operations
  init(deviceId) {
    if (this.deviceId === deviceId && this.db) {
      return; // Already initialized for this device
    }
    // Close existing connection if switching devices
    if (this.db) {
      this.db.close();
      this.db = null;
    }
    this.deviceId = deviceId;
    this.dbName = `${DB_NAME_PREFIX}_${deviceId}`;
  }

  async open() {
    if (!this.dbName) {
      throw new Error('LogStore not initialized. Call init(deviceId) first.');
    }
    if (this.db) return this.db;

    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, DB_VERSION);

      request.onupgradeneeded = (event) => {
        const db = event.target.result;

        if (!db.objectStoreNames.contains(STORES.EVENTS)) {
          const store = db.createObjectStore(STORES.EVENTS, {
            keyPath: 'id',
            autoIncrement: true,
          });
          // Index by timestamp for ordering
          store.createIndex('timestamp', 'timestamp', { unique: false });
          // Index by correlationId for grouping related events
          store.createIndex('correlationId', 'correlationId', { unique: false });
          // Index by eventType for filtering
          store.createIndex('eventType', 'eventType', { unique: false });
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

  // Generate a correlation ID to group related events (e.g., send_start -> encrypt -> send_complete)
  generateCorrelationId() {
    return `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
  }

  // Log an event
  async log(eventType, data = {}, correlationId = null) {
    await this.open();

    const event = {
      eventType,
      timestamp: Date.now(),
      correlationId: correlationId || this.generateCorrelationId(),
      deviceId: this.deviceId,
      data: this.sanitizeData(data),
    };

    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(STORES.EVENTS, 'readwrite');
      const store = tx.objectStore(STORES.EVENTS);
      const request = store.add(event);

      request.onsuccess = () => {
        event.id = request.result;
        resolve(event);
      };
      request.onerror = () => reject(request.error);
    });
  }

  // Sanitize data for storage - convert binary to base64, truncate large payloads
  sanitizeData(data) {
    const sanitized = {};

    for (const [key, value] of Object.entries(data)) {
      if (value instanceof Uint8Array) {
        // Convert to base64, truncate if large
        // Use Array.from() instead of spread to avoid triggering protobuf/crypto library side effects
        const base64 = btoa(String.fromCharCode.apply(null, Array.from(value.slice(0, 256))));
        sanitized[key] = {
          type: 'Uint8Array',
          length: value.length,
          preview: base64,
          truncated: value.length > 256,
        };
      } else if (value instanceof ArrayBuffer) {
        const arr = new Uint8Array(value);
        const base64 = btoa(String.fromCharCode.apply(null, Array.from(arr.slice(0, 256))));
        sanitized[key] = {
          type: 'ArrayBuffer',
          length: arr.length,
          preview: base64,
          truncated: arr.length > 256,
        };
      } else if (typeof value === 'object' && value !== null) {
        // Recursively sanitize nested objects
        sanitized[key] = this.sanitizeData(value);
      } else {
        sanitized[key] = value;
      }
    }

    return sanitized;
  }

  // Get all events, ordered by timestamp (newest first)
  async getAllEvents(limit = 500) {
    await this.open();

    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(STORES.EVENTS, 'readonly');
      const store = tx.objectStore(STORES.EVENTS);
      const index = store.index('timestamp');
      const request = index.openCursor(null, 'prev'); // Descending order

      const events = [];
      request.onsuccess = (event) => {
        const cursor = event.target.result;
        if (cursor && events.length < limit) {
          events.push(cursor.value);
          cursor.continue();
        } else {
          resolve(events);
        }
      };
      request.onerror = () => reject(request.error);
    });
  }

  // Get events by correlation ID (to see a full message flow)
  async getEventsByCorrelation(correlationId) {
    await this.open();

    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(STORES.EVENTS, 'readonly');
      const store = tx.objectStore(STORES.EVENTS);
      const index = store.index('correlationId');
      const request = index.getAll(correlationId);

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  // Get events by type
  async getEventsByType(eventType, limit = 100) {
    await this.open();

    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(STORES.EVENTS, 'readonly');
      const store = tx.objectStore(STORES.EVENTS);
      const index = store.index('eventType');
      const request = index.openCursor(IDBKeyRange.only(eventType), 'prev');

      const events = [];
      request.onsuccess = (event) => {
        const cursor = event.target.result;
        if (cursor && events.length < limit) {
          events.push(cursor.value);
          cursor.continue();
        } else {
          resolve(events);
        }
      };
      request.onerror = () => reject(request.error);
    });
  }

  // Get event count
  async getEventCount() {
    await this.open();

    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(STORES.EVENTS, 'readonly');
      const store = tx.objectStore(STORES.EVENTS);
      const request = store.count();

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  // Clear all logs
  async clearAll() {
    await this.open();

    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(STORES.EVENTS, 'readwrite');
      const store = tx.objectStore(STORES.EVENTS);
      const request = store.clear();

      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }
}

// Singleton instance
export const logStore = new LogStore();
export default logStore;
