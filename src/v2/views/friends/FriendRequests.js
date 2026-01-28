/**
 * FriendRequests View
 * - List pending incoming requests
 * - Accept/Reject buttons
 * - Verify code option
 */
import { navigate } from '../index.js';

let cleanup = null;
let pendingRequests = [];

export function render({ requests = [] } = {}) {
  return `
    <div class="view friend-requests">
      <header>
        <a href="/friends" data-navigo class="back">← Back</a>
        <h1>Friend Requests</h1>
      </header>

      ${requests.length === 0 ? `
        <div class="empty">
          <p>No pending requests</p>
        </div>
      ` : `
        <ul class="request-list">
          ${requests.map((req, i) => `
            <li class="request-item" data-index="${i}">
              <div class="request-info">
                <span class="username">${req.username || 'Unknown'}</span>
              </div>
              <div class="request-actions">
                <button class="accept-btn" data-index="${i}">Accept</button>
                <button class="reject-btn secondary" data-index="${i}">Reject</button>
                <button class="verify-btn secondary" data-index="${i}">Verify</button>
              </div>
            </li>
          `).join('')}
        </ul>
      `}
    </div>
  `;
}

export function mount(container, client, router) {
  // Get current pending requests
  pendingRequests = [];

  container.innerHTML = render({ requests: pendingRequests });

  // Listen for new friend requests
  const handleRequest = (req) => {
    pendingRequests.push(req);
    container.innerHTML = render({ requests: pendingRequests });
    attachListeners();
  };

  client.on('friendRequest', handleRequest);

  function attachListeners() {
    // Accept buttons
    container.querySelectorAll('.accept-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const index = parseInt(btn.dataset.index);
        const req = pendingRequests[index];
        if (req) {
          await req.accept();
          pendingRequests.splice(index, 1);
          container.innerHTML = render({ requests: pendingRequests });
          attachListeners();
        }
      });
    });

    // Reject buttons
    container.querySelectorAll('.reject-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const index = parseInt(btn.dataset.index);
        const req = pendingRequests[index];
        if (req && req.reject) {
          await req.reject();
        }
        pendingRequests.splice(index, 1);
        container.innerHTML = render({ requests: pendingRequests });
        attachListeners();
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
