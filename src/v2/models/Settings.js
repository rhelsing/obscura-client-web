import { BaseModel } from './BaseModel.js';

export class Settings extends BaseModel {
  static fields = {
    theme: 'string',
    notificationsEnabled: 'boolean',
    defaultTTL: 'string?',  // User's default TTL (e.g., '30d')
    webBackupEnabled: 'boolean?',
    webBackupEtag: 'string?',  // Server ETag for optimistic locking
    webBackupLastUpload: 'string?',  // ISO timestamp of last successful upload
  };

  static sync = 'lww';
  static collectable = true;
  static ttl = null;
  static private = true;  // Only syncs to own devices
}
