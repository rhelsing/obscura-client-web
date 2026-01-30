import { BaseModel } from './BaseModel.js';

export class PixRegistry extends BaseModel {
  static fields = {
    friendUsername: 'string',      // Primary identifier

    // Received pix state
    unviewedCount: 'number',       // Pix received but not yet viewed
    lastReceivedAt: 'timestamp?',  // When last pix was received
    totalReceived: 'number',       // Lifetime received count

    // Sent pix state
    sentPendingCount: 'number',    // Sent pix not yet viewed by recipient
    lastSentAt: 'timestamp?',      // When last pix was sent
    totalSent: 'number',           // Lifetime sent count

    // Streak
    streakCount: 'number',         // Current streak count
    streakExpiry: 'timestamp?',    // When streak expires if no activity
  };

  static sync = 'lww';
  static collectable = false;
  static private = true;           // Only syncs to own devices, never to friends
  static ttl = null;               // No expiration

  // Generate deterministic ID from friend username
  static getIdForFriend(friendUsername) {
    return `pixreg_${friendUsername}`;
  }
}
