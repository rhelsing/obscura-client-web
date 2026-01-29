import { BaseModel } from './BaseModel.js';

export class Streak extends BaseModel {
  static fields = {
    friendUsername: 'string',
    count: 'number',
    lastSentAt: 'timestamp',
    lastReceivedAt: 'timestamp',
    expiresAt: 'timestamp',
  };

  static sync = 'lww';
  static collectable = true;
  static ttl = null;  // Streaks don't expire by TTL
}
