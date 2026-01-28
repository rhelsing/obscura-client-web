/**
 * FriendList View
 * - Iterate client.friends Map
 * - Show username, status
 * - Tap → Chat view
 */
import { navigate } from '../index.js';

let cleanup = null;

export function render({ friends = [], pendingCount = 0 } = {}) {
  return `
    <div class="view friend-list">
      <header>
        <h1>Friends</h1>
        ${pendingCount > 0 ? `
          <a href="/friends/requests" data-navigo class="badge">${pendingCount} pending</a>
        ` : ''}
      </header>

      ${friends.length === 0 ? `
        <div class="empty">
          <p>No friends yet</p>
          <a href="/friends/add" data-navigo class="button">Add a Friend</a>
        </div>
      ` : `
        <ul class="friend-list-items">
          ${friends.map(f => `
            <li class="friend-item" data-username="${f.username}">
              <div class="friend-info">
                <span class="username">${f.username}</span>
                <span class="status ${f.status}">${f.status}</span>
              </div>
              <span class="arrow">→</span>
            </li>
          `).join('')}
        </ul>
      `}

      <a href="/friends/add" data-navigo class="fab">+</a>

      <nav class="bottom-nav">
        <a href="/stories" data-navigo>Feed</a>
        <a href="/messages" data-navigo>Messages</a>
        <a href="/friends" data-navigo class="active">Friends</a>
        <a href="/settings" data-navigo>Settings</a>
      </nav>
    </div>
  `;
}

export function mount(container, client, router) {
  const friends = [];
  let pendingCount = 0;

  if (client && client.friends) {
    for (const [username, data] of client.friends) {
      friends.push({ username, ...data });
      if (data.status === 'pending') {
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

  router.updatePageLinks();

  cleanup = () => {};
}

export function unmount() {
  if (cleanup) {
    cleanup();
    cleanup = null;
  }
}
