/**
 * StreakManager - Manages per-friend snap streaks
 *
 * A streak requires BOTH users to send snaps within 24h.
 * The count increments once per day when both have sent.
 */

const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;
const FOUR_HOURS = 4 * 60 * 60 * 1000;

export class StreakManager {
  constructor(client) {
    this.client = client;
    this._expirationTimer = null;
  }

  /**
   * Start the expiration check timer
   * Run on app open and every 30 minutes
   */
  startExpirationTimer() {
    // Check immediately on start
    this.checkExpiration();

    // Check every 30 minutes
    this._expirationTimer = setInterval(() => {
      this.checkExpiration();
    }, 30 * 60 * 1000);
  }

  /**
   * Stop the expiration timer
   */
  stopExpirationTimer() {
    if (this._expirationTimer) {
      clearInterval(this._expirationTimer);
      this._expirationTimer = null;
    }
  }

  /**
   * Record that we sent a snap to a friend
   * Updates lastSentAt and recalculates expiresAt
   */
  async recordSent(friendUsername) {
    const now = Date.now();
    const streak = await this._getOrCreateStreak(friendUsername);

    await this.client.streak.upsert(streak.id, {
      friendUsername,
      count: streak.data.count || 0,
      lastSentAt: now,
      lastReceivedAt: streak.data.lastReceivedAt || 0,
      expiresAt: this._calculateExpiresAt(now, streak.data.lastReceivedAt || 0),
    });
  }

  /**
   * Record that we received a snap from a friend
   * Updates lastReceivedAt
   */
  async recordReceived(friendUsername) {
    const now = Date.now();
    const streak = await this._getOrCreateStreak(friendUsername);

    await this.client.streak.upsert(streak.id, {
      friendUsername,
      count: streak.data.count || 0,
      lastSentAt: streak.data.lastSentAt || 0,
      lastReceivedAt: now,
      expiresAt: this._calculateExpiresAt(streak.data.lastSentAt || 0, now),
    });
  }

  /**
   * Check and increment streak when a snap is viewed
   * Only increments if:
   * 1. Both users sent within last 24h
   * 2. This is the first mutual exchange of the day
   */
  async checkAndIncrement(friendUsername) {
    const now = Date.now();
    const streak = await this._getOrCreateStreak(friendUsername);

    const lastSentAt = streak.data.lastSentAt || 0;
    const lastReceivedAt = streak.data.lastReceivedAt || 0;

    // Check if both sent within 24h
    const isSentWithin24h = (now - lastSentAt) < TWENTY_FOUR_HOURS;
    const isReceivedWithin24h = (now - lastReceivedAt) < TWENTY_FOUR_HOURS;

    if (!isSentWithin24h || !isReceivedWithin24h) {
      return; // Not mutual within 24h
    }

    // Check if this is the first mutual exchange of the day
    const lastIncrementDate = streak.data.lastIncrementDate || 0;
    const today = this._getStartOfDay(now);

    if (lastIncrementDate >= today) {
      return; // Already incremented today
    }

    // Increment the streak
    const newCount = (streak.data.count || 0) + 1;

    await this.client.streak.upsert(streak.id, {
      friendUsername,
      count: newCount,
      lastSentAt,
      lastReceivedAt,
      expiresAt: now + TWENTY_FOUR_HOURS,
      lastIncrementDate: today,
    });
  }

  /**
   * Check for expired streaks and reset them
   */
  async checkExpiration() {
    const now = Date.now();
    const streaks = await this.client.streak.all();

    for (const streak of streaks) {
      const expiresAt = streak.data.expiresAt || 0;

      if (expiresAt > 0 && expiresAt < now && streak.data.count > 0) {
        // Streak has expired, reset count
        await this.client.streak.upsert(streak.id, {
          ...streak.data,
          count: 0,
          expiresAt: 0,
        });
      }
    }
  }

  /**
   * Get streak info for a friend
   * Returns { count, expiresAt, isExpiringSoon }
   */
  async getStreak(friendUsername) {
    const streak = await this.client.streak
      .where({ 'data.friendUsername': friendUsername })
      .first();

    if (!streak) {
      return { count: 0, expiresAt: 0, isExpiringSoon: false };
    }

    const now = Date.now();
    const expiresAt = streak.data.expiresAt || 0;
    const isExpiringSoon = expiresAt > 0 && (expiresAt - now) < FOUR_HOURS;

    return {
      count: streak.data.count || 0,
      expiresAt,
      isExpiringSoon,
    };
  }

  /**
   * Get all streaks for display
   * Returns map of friendUsername -> streak info
   */
  async getAllStreaks() {
    const streaks = await this.client.streak.all();
    const result = {};
    const now = Date.now();

    for (const streak of streaks) {
      const expiresAt = streak.data.expiresAt || 0;
      result[streak.data.friendUsername] = {
        count: streak.data.count || 0,
        expiresAt,
        isExpiringSoon: expiresAt > 0 && (expiresAt - now) < FOUR_HOURS,
      };
    }

    return result;
  }

  /**
   * Get or create a streak entry for a friend
   */
  async _getOrCreateStreak(friendUsername) {
    let streak = await this.client.streak
      .where({ 'data.friendUsername': friendUsername })
      .first();

    if (!streak) {
      // Create new streak entry
      const id = `streak_${friendUsername}`;
      await this.client.streak.upsert(id, {
        friendUsername,
        count: 0,
        lastSentAt: 0,
        lastReceivedAt: 0,
        expiresAt: 0,
      });
      streak = await this.client.streak.find(id);
    }

    return streak;
  }

  /**
   * Calculate when the streak expires
   * Based on the older of the two timestamps + 24h
   */
  _calculateExpiresAt(lastSentAt, lastReceivedAt) {
    if (!lastSentAt || !lastReceivedAt) {
      return 0; // No expiration until both have sent
    }

    const older = Math.min(lastSentAt, lastReceivedAt);
    return older + TWENTY_FOUR_HOURS;
  }

  /**
   * Get the start of today (midnight UTC)
   */
  _getStartOfDay(timestamp) {
    const date = new Date(timestamp);
    date.setUTCHours(0, 0, 0, 0);
    return date.getTime();
  }
}
