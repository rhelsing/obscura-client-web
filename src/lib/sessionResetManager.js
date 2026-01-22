// Session Reset Manager
// Handles automatic session recovery when keys change (e.g., after browser data clear)

import { signalStore } from './signalStore.js';
import { sessionManager } from './sessionManager.js';
import { friendStore, FriendStatus } from './friendStore.js';
import gateway from '../api/gateway.js';
import client from '../api/client.js';

const RESET_COOLDOWN_MS = 30000; // 30 seconds between reset attempts per user
const RESET_WINDOW_MS = 5000;    // Ignore duplicate resets within 5 seconds

class SessionResetManager {
  constructor() {
    this.pendingResets = new Map();  // userId -> { timestamp, attempts }
    this.recentResets = new Map();   // userId -> timestamp of last completed reset
    this.failedEnvelopeIds = new Set(); // Track envelopes we've already tried to reset for
  }

  // Check if we should initiate a reset for this user (rate limiting)
  shouldInitiateReset(userId) {
    const pending = this.pendingResets.get(userId);
    if (pending) {
      const elapsed = Date.now() - pending.timestamp;
      if (elapsed < RESET_COOLDOWN_MS) {
        console.log(`[SessionReset] Cooldown active for ${userId}, ${Math.ceil((RESET_COOLDOWN_MS - elapsed) / 1000)}s remaining`);
        return false;
      }
    }
    return true;
  }

  // Mark that we're starting a reset
  markResetStarted(userId) {
    const existing = this.pendingResets.get(userId) || { attempts: 0 };
    this.pendingResets.set(userId, {
      timestamp: Date.now(),
      attempts: existing.attempts + 1,
    });
  }

  // Mark reset as completed
  markResetCompleted(userId) {
    this.pendingResets.delete(userId);
    this.recentResets.set(userId, Date.now());
  }

  // Check if we recently completed a reset with this user
  hasRecentReset(userId) {
    const timestamp = this.recentResets.get(userId);
    if (!timestamp) return false;
    return (Date.now() - timestamp) < RESET_WINDOW_MS;
  }

  // Check if we already tried to reset for this envelope
  hasTriedEnvelope(envelopeId) {
    return this.failedEnvelopeIds.has(envelopeId);
  }

  // Mark that we've tried this envelope
  markEnvelopeTried(envelopeId) {
    this.failedEnvelopeIds.add(envelopeId);
    // Clean up old entries after a while
    setTimeout(() => this.failedEnvelopeIds.delete(envelopeId), 60000);
  }

  // Initiate session reset protocol to a user
  // Called when we fail to decrypt their message
  async initiateReset(toUserId, reason = 'decryption_failed') {
    console.log(`[SessionReset] Initiating reset to ${toUserId}, reason: ${reason}`);

    if (!this.shouldInitiateReset(toUserId)) {
      return false;
    }

    this.markResetStarted(toUserId);

    try {
      // 1. Delete any stale session we have for them
      const sessionKey = `${toUserId}:1`;
      await signalStore.removeSession(sessionKey);
      sessionManager.ciphers.delete(sessionKey);
      console.log(`[SessionReset] Deleted stale session for ${toUserId}`);

      // 2. Delete stale trusted identity (allows re-TOFU)
      await signalStore._delete('trustedIdentities', sessionKey);
      console.log(`[SessionReset] Deleted stale trusted identity for ${toUserId}`);

      // 3. Fetch their CURRENT PreKeyBundle from server (their new keys)
      // 4. Establish NEW session with their current keys
      await sessionManager.establishSession(toUserId);
      console.log(`[SessionReset] Established new session with ${toUserId}`);

      // 5. Restore friend relationship
      // If we're receiving a message from them, they consider us a friend
      const friend = await friendStore.getFriend(toUserId);
      if (!friend) {
        // They were our friend before but we lost them (cleared data)
        // Auto-restore the relationship as accepted
        await friendStore.addFriend(toUserId, 'Unknown', FriendStatus.ACCEPTED);
        console.log(`[SessionReset] Restored friend relationship with ${toUserId}`);
      }

      // 6. Ensure gateway proto is loaded
      await gateway.loadProto();

      // 7. Send SESSION_RESET message (encrypted with their current keys)
      const username = localStorage.getItem('obscura_username') || 'Unknown';
      const clientMsgBytes = gateway.encodeClientMessage({
        type: 'SESSION_RESET',
        username: username,
        resetReason: reason,
        resetTimestamp: Date.now(),
      });

      const encrypted = await sessionManager.encrypt(toUserId, clientMsgBytes);
      const protobufData = gateway.encodeOutgoingMessage(encrypted.body, encrypted.protoType);
      await client.sendMessage(toUserId, protobufData);

      console.log(`[SessionReset] Sent SESSION_RESET to ${toUserId}`);
      this.markResetCompleted(toUserId);
      return true;
    } catch (err) {
      console.error(`[SessionReset] Failed to initiate reset to ${toUserId}:`, err);
      return false;
    }
  }

  // Handle incoming SESSION_RESET message
  // Called when someone sends us a SESSION_RESET
  async handleSessionReset(fromUserId, msg) {
    console.log(`[SessionReset] Received SESSION_RESET from ${fromUserId}, reason: ${msg.resetReason}`);

    // Check if we already handled a recent reset from this user (dedup)
    if (this.hasRecentReset(fromUserId)) {
      console.log(`[SessionReset] Ignoring duplicate reset from ${fromUserId} (within window)`);
      return;
    }

    try {
      // 1. Delete our stale session with this user (if any)
      const sessionKey = `${fromUserId}:1`;
      await signalStore.removeSession(sessionKey);
      sessionManager.ciphers.delete(sessionKey);
      console.log(`[SessionReset] Deleted stale session for ${fromUserId}`);

      // 2. Delete stale trusted identity (allows re-TOFU with their new key)
      await signalStore._delete('trustedIdentities', sessionKey);
      console.log(`[SessionReset] Deleted stale trusted identity for ${fromUserId}`);

      // 3. Fetch their NEW PreKeyBundle from server
      // 4. Establish new session
      await sessionManager.establishSession(fromUserId);
      console.log(`[SessionReset] Established new session with ${fromUserId}`);

      // 5. Ensure friend relationship exists
      // If they sent us a SESSION_RESET, they consider us a friend
      const friend = await friendStore.getFriend(fromUserId);
      if (!friend) {
        // They were our friend before but we lost them (cleared data)
        // Auto-restore the relationship
        await friendStore.addFriend(fromUserId, msg.username || 'Unknown', FriendStatus.ACCEPTED);
        console.log(`[SessionReset] Restored friend relationship with ${fromUserId}`);
      } else if (friend.status !== FriendStatus.ACCEPTED) {
        // Update to accepted if pending
        await friendStore.updateFriendStatus(fromUserId, FriendStatus.ACCEPTED);
        console.log(`[SessionReset] Updated friend status to accepted for ${fromUserId}`);
      }

      this.markResetCompleted(fromUserId);
      console.log(`[SessionReset] Session reset completed with ${fromUserId}`);
    } catch (err) {
      console.error(`[SessionReset] Failed to handle reset from ${fromUserId}:`, err);
      throw err;
    }
  }
}

export const sessionResetManager = new SessionResetManager();
export default sessionResetManager;
