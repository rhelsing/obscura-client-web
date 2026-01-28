/**
 * ConversationList View
 * - List friends as conversations
 * - Show last message preview (if available)
 * - Tap → Chat
 */
import { navigate } from '../index.js';

let cleanup = null;

export function render({ conversations = [] } = {}) {
  return `
    <div class="view conversation-list">
      <header>
        <h1>Messages</h1>
      </header>

      ${conversations.length === 0 ? `
        <div class="empty">
          <p>No conversations yet</p>
          <a href="/friends/add" data-navigo class="button">Add a Friend</a>
        </div>
      ` : `
        <ul class="conversation-items">
          ${conversations.map(c => `
            <li class="conversation-item" data-username="${c.username}">
              <div class="conversation-info">
                <span class="username">${c.username}</span>
                ${c.lastMessage ? `
                  <span class="preview">${c.lastMessage}</span>
                ` : `
                  <span class="preview empty">No messages yet</span>
                `}
              </div>
              ${c.unread ? `<span class="unread-badge">${c.unread}</span>` : ''}
              <span class="arrow">→</span>
            </li>
          `).join('')}
        </ul>
      `}

      <nav class="bottom-nav">
        <a href="/stories" data-navigo>Feed</a>
        <a href="/messages" data-navigo class="active">Messages</a>
        <a href="/friends" data-navigo>Friends</a>
        <a href="/settings" data-navigo>Settings</a>
      </nav>
    </div>
  `;
}

export function mount(container, client, router) {
  const conversations = [];

  // Build conversation list from friends
  if (client && client.friends) {
    for (const [username, data] of client.friends) {
      if (data.status === 'accepted') {
        conversations.push({
          username,
          lastMessage: null, // TODO: Query from message store
          unread: 0 // TODO: Track unread count
        });
      }
    }
  }

  container.innerHTML = render({ conversations });

  // Click handlers
  const items = container.querySelectorAll('.conversation-item');
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
