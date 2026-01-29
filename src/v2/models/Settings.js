import { BaseModel } from './BaseModel.js';

export class Settings extends BaseModel {
  static fields = {
    theme: 'string',
    notificationsEnabled: 'boolean',
    defaultTTL: 'string?',  // User's default TTL (e.g., '30d')
  };

  static sync = 'lww';
  static collectable = true;
  static ttl = null;
  static private = true;  // Only syncs to own devices
}
