/**
 * FriendList View
 * - Iterate client.friends Map
 * - Show username, status
 * - Tap → Chat view
 */
import { navigate, clearClient } from '../index.js';
import { renderNav, initNav } from '../components/Nav.js';
import { ObscuraClient } from '../../lib/ObscuraClient.js';

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
          ${friends.map(f => `
            <card class="friend-item" data-username="${f.username}">
              <cluster>
                <ry-icon name="user"></ry-icon>
                <stack gap="none">
                  <strong>${f.username}</strong>
                  <badge variant="${f.status === 'accepted' ? 'success' : 'warning'}">${f.status}</badge>
                </stack>
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

export function mount(container, client, router) {
  const friends = [];
  let pendingCount = 0;

  if (client && client.friends && client.friends.friends) {
    for (const [username, data] of client.friends.friends) {
      friends.push({ username, ...data });
      // FriendManager uses 'pending_incoming' for incoming requests
      if (data.status === 'pending_incoming') {
        pendingCount++;
      }
    }
  }

  container.innerHTML = render({ friends, pendingCount });

  // Click handlers for friend items
  const items = container.querySelectorAll('.friend-item');
  items.forEach(item => {
    item.addEventListener('click', () => {
      const username = item.dataset.username;
      navigate(`/messages/${username}`);
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
