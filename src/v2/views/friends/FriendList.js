/**
 * FriendList View
 * - Iterate client.friends Map
 * - Show username, status
 * - Tap → Chat view
 */
import { navigate, clearClient } from '../index.js';
import { renderNav, initNav } from '../components/Nav.js';
import { ObscuraClient } from '../../lib/ObscuraClient.js';
import { generateVerifyCode } from '../../crypto/signatures.js';

let cleanup = null;

export function render({ friends = [], pendingCount = 0 } = {}) {
  return `
    <div class="view friend-list">
      <header>
        <h1>Friends</h1>
        ${pendingCount > 0 ? `
          <a href="/friends/requests" data-navigo><badge variant="primary">${pendingCount} pending</badge></a>
        ` : ''}
      </header>

      ${friends.length === 0 ? `
        <div class="empty">
          <p>No friends yet</p>
          <a href="/friends/add" data-navigo><button>Add a Friend</button></a>
        </div>
      ` : `
        <stack gap="sm" class="friend-list-items">
          ${friends.map(f => f.status === 'pending_incoming' ? `
            <card class="friend-item pending" data-username="${f.username}">
              <cluster>
                <ry-icon name="user"></ry-icon>
                <stack gap="none">
                  <strong>${f.displayName || f.username}</strong>
                  <badge variant="warning">wants to be friends</badge>
                </stack>
              </cluster>
              <cluster style="margin-top: var(--ry-space-2)">
                <button size="sm" class="accept-btn" data-username="${f.username}">Accept</button>
                <button variant="secondary" size="sm" class="reject-btn" data-username="${f.username}">Reject</button>
              </cluster>
            </card>
          ` : `
            <card class="friend-item" data-username="${f.username}">
              <cluster>
                <ry-icon name="user"></ry-icon>
                <stack gap="none">
                  <strong>${f.displayName || f.username}</strong>
                  ${f.status === 'pending_outgoing' ? `<badge variant="warning">pending</badge>` : ''}
                </stack>
                ${f.status === 'accepted' ? `<button variant="ghost" size="sm" class="verify-btn" data-username="${f.username}">Verify</button>` : ''}
                <ry-icon name="chevron-right"></ry-icon>
              </cluster>
            </card>
          `).join('')}
        </stack>
      `}

      <a href="/friends/add" data-navigo class="fab">+</a>

      ${renderNav('friends')}
    </div>
  `;
}

export async function mount(container, client, router) {
  const friends = [];
  let pendingCount = 0;

  if (client && client.friends && client.friends.friends) {
    for (const [username, data] of client.friends.friends) {
      friends.push({ username, ...data });
      if (data.status === 'pending_incoming') {
        pendingCount++;
      }
    }
  }

  // Look up display names for all friends
  for (const f of friends) {
    f.displayName = await client.getDisplayName(f.username);
  }

  container.innerHTML = render({ friends, pendingCount });

  // Click handlers for non-pending friend items (go to chat)
  const items = container.querySelectorAll('.friend-item:not(.pending)');
  items.forEach(item => {
    item.addEventListener('click', (e) => {
      // Don't navigate if clicking verify button
      if (e.target.closest('.verify-btn')) return;
      const username = item.dataset.username;
      navigate(`/messages/${username}`);
    });
  });

  // Verify button handlers for accepted friends
  container.querySelectorAll('.verify-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const username = btn.dataset.username;
      const friend = client.friends.get(username);
      if (friend) {
        const devices = friend.devices || [];
        // Sort by deviceUUID for deterministic "primary" device across all clients
        const sortedDevices = [...devices].sort((a, b) =>
          (a.deviceUUID || '').localeCompare(b.deviceUUID || '')
        );
        const primaryDevice = sortedDevices[0];
        const signalIdentityKey = primaryDevice?.signalIdentityKey;

        // Create request object for verify view
        window.__verifyRequest = {
          username,
          async getVerifyCode() {
            if (!signalIdentityKey) return '----';
            return generateVerifyCode(signalIdentityKey);
          },
        };
        navigate(`/friends/verify/${username}`);
      }
    });
  });

  // Accept button handlers
  container.querySelectorAll('.accept-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const username = btn.dataset.username;
      btn.disabled = true;
      btn.textContent = '...';
      try {
        const friend = client.friends.get(username);
        if (friend) {
          const devices = friend.devices || [];
          const primaryDevice = devices[0];
          client.friends.store(username, devices, 'accepted');
          // Sync to own devices
          await client._syncFriendToOwnDevices(username, 'add', devices, 'accepted');
          if (primaryDevice?.serverUserId) {
            await client._sendFriendResponse(primaryDevice.serverUserId, username, true);
          }
        }
        // Re-mount to refresh the list
        mount(container, client, router);
      } catch (err) {
        console.error('Failed to accept:', err);
        btn.disabled = false;
        btn.textContent = 'Accept';
      }
    });
  });

  // Reject button handlers
  container.querySelectorAll('.reject-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const username = btn.dataset.username;
      btn.disabled = true;
      btn.textContent = '...';
      try {
        const friend = client.friends.get(username);
        if (friend) {
          const primaryDevice = friend.devices?.[0];
          client.friends.remove(username);
          if (primaryDevice?.serverUserId) {
            await client._sendFriendResponse(primaryDevice.serverUserId, username, false);
          }
        }
        mount(container, client, router);
      } catch (err) {
        console.error('Failed to reject:', err);
        btn.disabled = false;
        btn.textContent = 'Reject';
      }
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

  cleanup = () => {};
}

export function unmount() {
  if (cleanup) {
    cleanup();
    cleanup = null;
  }
}
