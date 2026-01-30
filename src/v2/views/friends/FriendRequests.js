/**
 * FriendRequests View
 * - List pending incoming requests
 * - Accept/Reject buttons
 * - Verify code option
 *
 * IMPORTANT: Loads existing pending requests from FriendManager on mount.
 * The server dumps queued messages on connect, so requests may already exist.
 */
import { navigate } from '../index.js';
import { generateVerifyCode } from '../../crypto/signatures.js';

let cleanup = null;
let pendingRequests = [];
let currentClient = null;

/**
 * Reconstruct a request object from stored friend data
 * Provides accept/reject/getVerifyCode methods
 */
function reconstructRequest(friend, client) {
  const devices = friend.devices || [];
  const primaryDevice = devices[0];
  const signalIdentityKey = primaryDevice?.signalIdentityKey;

  return {
    username: friend.username,
    devices: devices,
    sourceUserId: primaryDevice?.serverUserId,

    async getVerifyCode() {
      if (!signalIdentityKey) return null;
      return generateVerifyCode(signalIdentityKey);
    },

    async accept() {
      client.friends.store(friend.username, devices, 'accepted');
      if (primaryDevice?.serverUserId) {
        await client._sendFriendResponse(primaryDevice.serverUserId, friend.username, true);
      }
    },

    async reject() {
      client.friends.remove(friend.username);
      if (primaryDevice?.serverUserId) {
        await client._sendFriendResponse(primaryDevice.serverUserId, friend.username, false);
      }
    },
  };
}

export function render({ requests = [] } = {}) {
  return `
    <div class="view friend-requests">
      <header>
        <a href="/friends" data-navigo class="back"><ry-icon name="chevron-left"></ry-icon> Back</a>
        <h1>Friend Requests</h1>
      </header>

      ${requests.length === 0 ? `
        <div class="empty">
          <p>No pending requests</p>
        </div>
      ` : `
        <stack gap="sm" class="request-list">
          ${requests.map((req, i) => `
            <card class="request-item" data-index="${i}">
              <cluster>
                <ry-icon name="user"></ry-icon>
                <strong style="flex: 1">${req.displayName || req.username || 'Unknown'}</strong>
              </cluster>
              <actions>
                <button size="sm" class="accept-btn" data-index="${i}">Accept</button>
                <button variant="secondary" size="sm" class="reject-btn" data-index="${i}">Reject</button>
                <button variant="ghost" size="sm" class="verify-btn" data-index="${i}">Verify</button>
              </actions>
            </card>
          `).join('')}
        </stack>
      `}
    </div>
  `;
}

export async function mount(container, client, router) {
  currentClient = client;

  // Load existing pending requests from FriendManager
  const existingPending = client.friends.getPendingIncoming();
  pendingRequests = existingPending.map(f => reconstructRequest(f, client));

  // Look up display names for all requests
  for (const req of pendingRequests) {
    req.displayName = await client.getDisplayName(req.username);
  }

  container.innerHTML = render({ requests: pendingRequests });

  // Listen for new friend requests
  const handleRequest = (req) => {
    // Check if we already have this request (avoid duplicates)
    const exists = pendingRequests.some(r => r.username === req.username);
    if (!exists) {
      pendingRequests.push(req);
      container.innerHTML = render({ requests: pendingRequests });
      attachListeners();
    }
  };

  client.on('friendRequest', handleRequest);

  function attachListeners() {
    // Accept buttons
    container.querySelectorAll('.accept-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const index = parseInt(btn.dataset.index);
        const req = pendingRequests[index];
        if (req) {
          btn.disabled = true;
          btn.textContent = '...';
          try {
            await req.accept();
            pendingRequests.splice(index, 1);
            container.innerHTML = render({ requests: pendingRequests });
            attachListeners();
          } catch (err) {
            console.error('Failed to accept:', err);
            btn.disabled = false;
            btn.textContent = 'Accept';
          }
        }
      });
    });

    // Reject buttons
    container.querySelectorAll('.reject-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const index = parseInt(btn.dataset.index);
        const req = pendingRequests[index];
        if (req) {
          btn.disabled = true;
          btn.textContent = '...';
          try {
            await req.reject();
            pendingRequests.splice(index, 1);
            container.innerHTML = render({ requests: pendingRequests });
            attachListeners();
          } catch (err) {
            console.error('Failed to reject:', err);
            btn.disabled = false;
            btn.textContent = 'Reject';
          }
        }
      });
    });

    // Verify buttons
    container.querySelectorAll('.verify-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const index = parseInt(btn.dataset.index);
        const req = pendingRequests[index];
        if (req) {
          // Store request for verify view
          window.__verifyRequest = req;
          navigate(`/friends/verify/${req.username || 'friend'}`);
        }
      });
    });

    router.updatePageLinks();
  }

  attachListeners();

  cleanup = () => {
    client.off('friendRequest', handleRequest);
  };
}

export function unmount() {
  if (cleanup) {
    cleanup();
    cleanup = null;
  }
}
