/**
 * ConversationList View
 * - List friends as conversations
 * - Show last message preview (if available)
 * - Tap → Chat
 */
import { navigate, clearClient } from '../index.js';
import { renderNav, initNav } from '../components/Nav.js';
import { ObscuraClient } from '../../lib/ObscuraClient.js';

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
          <a href="/friends/add" data-navigo><button>Add a Friend</button></a>
        </div>
      ` : `
        <stack gap="sm" class="conversation-items">
          ${conversations.map(c => `
            <card class="conversation-item" data-username="${c.username}">
              <cluster>
                <ry-icon name="edit"></ry-icon>
                <stack gap="none" style="flex: 1">
                  <strong>${c.username}</strong>
                  ${c.lastMessage ? `
                    <span style="color: var(--ry-color-text-muted); font-size: var(--ry-text-sm)">${c.lastMessage}</span>
                  ` : `
                    <span style="color: var(--ry-color-text-muted); font-size: var(--ry-text-sm); font-style: italic">No messages yet</span>
                  `}
                </stack>
                ${c.unread ? `<badge variant="primary">${c.unread}</badge>` : ''}
                <ry-icon name="chevron-right"></ry-icon>
              </cluster>
            </card>
          `).join('')}
        </stack>
      `}

      ${renderNav('messages')}
    </div>
  `;
}

export async function mount(container, client, router) {
  const conversations = [];

  // Build conversation list from friends
  if (client && client.friends && client.friends.friends) {
    for (const [username, data] of client.friends.friends) {
      if (data.status === 'accepted') {
        // Load last message for this conversation
        let lastMessage = null;
        try {
          const messages = await client.getMessages(username);
          if (messages.length > 0) {
            const last = messages[messages.length - 1];
            const text = last.text || last.content || '';
            // Truncate if too long
            lastMessage = text.length > 40 ? text.slice(0, 40) + '...' : text;
            // Prefix with "You: " if sent by us
            if (last.isSent) {
              lastMessage = 'You: ' + lastMessage;
            }
          }
        } catch (err) {
          console.warn('Failed to load messages for', username, err);
        }

        conversations.push({
          username,
          lastMessage,
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
