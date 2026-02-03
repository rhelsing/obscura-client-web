/**
 * PixList View
 * Shows incoming pix grouped by sender
 * Tap on a sender's pix to view them
 */
import { navigate, clearClient, getBadgeCounts } from '../index.js';
import { renderNav, initNav } from '../components/Nav.js';
import { ObscuraClient } from '../../lib/ObscuraClient.js';
import { renderPixIndicator, renderPixIndicatorOpened, renderPixIndicatorSent, renderPixIndicatorSentOpened } from '../components/PixIndicator.js';

let cleanup = null;

export function render({ pixFriends = [] } = {}) {
  // pixFriends = [{ username, displayName, unviewedCount, sentCount, sentViewedCount, lastPixTime, hasUnviewed, type, streakCount }]
  // type: 'received' | 'sent' | 'both'

  return `
    <div class="view pix-list">
      <header>
        <h1>Pix</h1>
        <a href="/pix/camera" data-navigo><button variant="ghost" size="sm" style="font-size: 18px;">📷</button></a>
      </header>

      ${pixFriends.length === 0 ? `
        <div class="empty">
          <p>No pix yet</p>
          <a href="/pix/camera" data-navigo><button>Send a Pix</button></a>
        </div>
      ` : `
        <ry-stack gap="sm" class="pix-items">
          ${pixFriends.map(friend => {
            const displayName = friend.displayName || friend.username;
            const hasUnviewed = friend.unviewedCount > 0;
            const hasPendingSent = friend.sentCount > friend.sentViewedCount;
            const streakCount = friend.streakCount || 0;
            const isDisabled = !hasUnviewed; // Disable if no unviewed pix

            // Determine indicator:
            // - Received unviewed: filled square
            // - Sent pending: filled chevron
            // - Sent opened: outlined chevron
            // - Received opened: outlined square
            let indicator;
            if (hasUnviewed) {
              indicator = renderPixIndicator({ count: friend.unviewedCount });
            } else if (hasPendingSent) {
              indicator = renderPixIndicatorSent();
            } else if (friend.sentViewedCount > 0) {
              indicator = renderPixIndicatorSentOpened();
            } else {
              indicator = renderPixIndicatorOpened();
            }

            // Determine status text
            let statusText = '';
            let statusColor = 'var(--ry-color-text-muted)';
            if (hasUnviewed) {
              statusText = `${friend.unviewedCount} new pix`;
              statusColor = 'var(--ry-color-red-500)';
            } else if (hasPendingSent) {
              statusText = 'Delivered';
              statusColor = 'var(--ry-color-red-500)';
            } else if (friend.sentViewedCount > 0) {
              statusText = 'Opened';
            } else if (friend.type === 'received') {
              statusText = 'Opened';
            } else {
              statusText = 'Tap to send';
            }

            return `
            <ry-card class="pix-item ${hasUnviewed ? 'pix-item--new' : 'pix-item--opened'} ${isDisabled ? 'pix-item--disabled' : ''}"
                  data-username="${friend.username}"
                  data-has-unviewed="${hasUnviewed}"
                  data-has-pending="${hasPendingSent}"
                  data-disabled="${isDisabled}">
              <ry-cluster>
                ${indicator}
                <ry-stack gap="none" style="flex: 1">
                  <ry-cluster gap="xs">
                    <strong>${displayName}</strong>
                    ${streakCount > 0 ? `<span class="streak-badge">🔥 ${streakCount}</span>` : ''}
                  </ry-cluster>
                  <span style="color: ${statusColor}; font-size: var(--ry-text-sm)">
                    ${statusText}
                  </span>
                </ry-stack>
                ${!isDisabled ? '<ry-icon name="chevron-right"></ry-icon>' : ''}
              </ry-cluster>
            </ry-card>
          `}).join('')}
        </ry-stack>
      `}

      ${renderNav('pix', getBadgeCounts())}
    </div>
  `;
}

export async function mount(container, client, router) {
  const pixFriends = [];
  const friendPixData = new Map(); // username -> { unviewedCount, sentCount, sentViewedCount, lastPixTime, type, sentIn3Days, receivedIn3Days, lastSentAt, lastReceivedAt }

  const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;
  const now = Date.now();

  // Query ALL pix to show both received and sent
  if (client.pix) {
    try {
      const allPix = await client.pix.all();

      for (const pix of allPix) {
        if (pix.data?._deleted) continue;

        const isReceived = pix.data?.recipientUsername === client.username;
        const isSent = pix.data?.senderUsername === client.username;

        if (!isReceived && !isSent) continue;

        // Determine the friend username (the other party)
        const friendUsername = isReceived
          ? pix.data?.senderUsername
          : pix.data?.recipientUsername;

        if (!friendUsername) continue;

        if (!friendPixData.has(friendUsername)) {
          friendPixData.set(friendUsername, {
            unviewedCount: 0,
            sentCount: 0,
            sentViewedCount: 0,
            lastPixTime: 0,
            type: null,
            sentIn3Days: 0,
            receivedIn3Days: 0,
            lastSentAt: 0,
            lastReceivedAt: 0
          });
        }
        const data = friendPixData.get(friendUsername);

        // Track most recent pix time
        const pixTime = pix.timestamp || 0;
        if (pixTime > data.lastPixTime) {
          data.lastPixTime = pixTime;
        }

        // Check if within last 3 days
        const isRecent = (now - pixTime) < THREE_DAYS_MS;

        if (isReceived) {
          data.type = data.type === 'sent' ? 'both' : 'received';
          if (!pix.data?.viewedAt) {
            data.unviewedCount++;
          }
          if (isRecent) {
            data.receivedIn3Days++;
          }
          if (pixTime > data.lastReceivedAt) {
            data.lastReceivedAt = pixTime;
          }
        }

        if (isSent) {
          data.type = data.type === 'received' ? 'both' : 'sent';
          data.sentCount++;
          if (pix.data?.viewedAt) {
            data.sentViewedCount++;
          }
          if (isRecent) {
            data.sentIn3Days++;
          }
          if (pixTime > data.lastSentAt) {
            data.lastSentAt = pixTime;
          }
        }
      }

      // Load existing PixRegistry entries for streak counts
      const registryMap = new Map();
      if (client.pixRegistry) {
        try {
          const registries = await client.pixRegistry.all();
          for (const reg of registries) {
            if (reg.data?.friendUsername) {
              registryMap.set(reg.data.friendUsername, reg);
            }
          }
        } catch (err) {
          console.warn('Failed to load pixRegistry:', err);
        }
      }

      // Convert to sorted array and calculate streaks
      for (const [username, data] of friendPixData) {
        let streakCount = 0;
        let streakEarnedAt = null;

        // Get existing registry data
        const existingReg = registryMap.get(username);
        const existingStreak = existingReg?.data?.streakCount || 0;
        const existingEarnedAt = existingReg?.data?.streakEarnedAt || 0;

        // Streak logic:
        // - +1 per day as long as both have activity within 3 days
        // - Reset to 0 if 3 days pass without mutual exchange
        const ONE_DAY_MS = 24 * 60 * 60 * 1000;
        const bothActive = data.lastSentAt && data.lastReceivedAt &&
          (now - data.lastSentAt) < THREE_DAYS_MS && (now - data.lastReceivedAt) < THREE_DAYS_MS;
        const daysSinceEarned = existingEarnedAt ? Math.floor((now - existingEarnedAt) / ONE_DAY_MS) : 0;

        if (bothActive) {
          if (existingStreak > 0) {
            // Add days passed since last earned (but at least maintain current)
            streakCount = existingStreak + daysSinceEarned;
            streakEarnedAt = daysSinceEarned > 0 ? now : existingEarnedAt;
          } else {
            // Fresh streak start
            streakCount = 1;
            streakEarnedAt = now;
          }
        } else {
          // 3 days without mutual activity, streak broken
          streakCount = 0;
          streakEarnedAt = null;
        }

        // Update PixRegistry only if data changed
        if (client.pixRegistry) {
          const regId = `pixreg_${username}`;
          const newData = {
            friendUsername: username,
            unviewedCount: data.unviewedCount,
            lastReceivedAt: data.lastReceivedAt || null,
            totalReceived: data.receivedIn3Days,
            sentPendingCount: data.sentCount - data.sentViewedCount,
            lastSentAt: data.lastSentAt || null,
            totalSent: data.sentIn3Days,
            streakCount,
            streakExpiry: streakCount > 0 ? now + THREE_DAYS_MS : null,
            streakEarnedAt
          };

          // Compare to existing - only upsert if meaningful change
          const existing = existingReg?.data;
          const hasChanged = !existing ||
            existing.unviewedCount !== newData.unviewedCount ||
            existing.sentPendingCount !== newData.sentPendingCount ||
            existing.streakCount !== newData.streakCount ||
            existing.totalReceived !== newData.totalReceived ||
            existing.totalSent !== newData.totalSent;

          if (hasChanged) {
            try {
              await client.pixRegistry.upsert(regId, newData);
            } catch (err) {
              console.warn('Failed to update pixRegistry:', err);
            }
          }
        }

        pixFriends.push({
          username,
          unviewedCount: data.unviewedCount,
          sentCount: data.sentCount,
          sentViewedCount: data.sentViewedCount,
          lastPixTime: data.lastPixTime,
          hasUnviewed: data.unviewedCount > 0,
          type: data.type,
          streakCount
        });
      }

      // Sort: unviewed first, then pending sent, then by most recent
      pixFriends.sort((a, b) => {
        if (a.hasUnviewed && !b.hasUnviewed) return -1;
        if (!a.hasUnviewed && b.hasUnviewed) return 1;
        const aPending = a.sentCount > a.sentViewedCount;
        const bPending = b.sentCount > b.sentViewedCount;
        if (aPending && !bPending) return -1;
        if (!aPending && bPending) return 1;
        return b.lastPixTime - a.lastPixTime;
      });
    } catch (err) {
      console.warn('Failed to load pix:', err);
    }
  }

  // Look up display names for all friends
  for (const friend of pixFriends) {
    friend.displayName = await client.getDisplayName(friend.username);
  }

  container.innerHTML = render({ pixFriends });

  // Click handlers - only for items with unviewed pix
  const items = container.querySelectorAll('.pix-item');
  items.forEach(item => {
    item.addEventListener('click', (e) => {
      e.preventDefault();
      // Skip disabled items (no unviewed pix)
      if (item.dataset.disabled === 'true') {
        return;
      }
      const username = item.dataset.username;
      navigate(`/pix/view/${username}`);
    });
  });

  // Init nav
  initNav(container, () => {
    client.disconnect();
    ObscuraClient.clearSession();
    clearClient();
    navigate('/login');
  });

  router.updatePageLinks();

  // Listen for new pix - refresh list only when relevant to this user
  const onModelSync = async (event) => {
    if (event.model === 'pix') {
      // Decode data from Uint8Array to check relevance
      let pixData = {};
      try {
        if (event.data instanceof Uint8Array) {
          pixData = JSON.parse(new TextDecoder().decode(event.data));
        } else if (event.data) {
          pixData = event.data;
        }
      } catch (e) {
        // If we can't decode, refresh to be safe
        pixData = {};
      }

      // Only refresh if this pix involves us (we're sender or recipient)
      const isRelevant = !pixData.recipientUsername || !pixData.senderUsername ||
                         pixData.recipientUsername === client.username ||
                         pixData.senderUsername === client.username;

      if (isRelevant) {
        console.log('[PixList] Relevant pix sync, refreshing list');
        // Small delay to ensure IndexedDB is updated
        await new Promise(r => setTimeout(r, 100));
        // Remove old listener before re-mounting
        client.off('modelSync', onModelSync);
        mount(container, client, router);
      }
    }
  };
  client.on('modelSync', onModelSync);

  cleanup = () => {
    client.off('modelSync', onModelSync);
  };
}

export function unmount() {
  if (cleanup) {
    cleanup();
    cleanup = null;
  }
}
