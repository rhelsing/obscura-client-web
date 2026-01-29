/**
 * GroupChat View
 * - Group message list
 * - Send messages to group
 */
import { navigate } from '../index.js';

let cleanup = null;
let messages = [];

export function render({ group = null, messages = [], loading = false, sending = false } = {}) {
  if (loading) {
    return `<div class="view group-chat"><div class="loading">Loading...</div></div>`;
  }

  if (!group) {
    return `<div class="view group-chat"><div class="error">Group not found</div></div>`;
  }

  const groupName = group.data?.name || 'Group';
  const members = parseMembers(group.data?.members);

  return `
    <div class="view group-chat">
      <header>
        <a href="/chats" data-navigo class="back">← Back</a>
        <div class="group-header">
          <h1>${escapeHtml(groupName)}</h1>
          <span class="member-count">${members.length} members</span>
        </div>
      </header>

      <div class="messages-container" id="messages">
        ${messages.length === 0 ? `
          <div class="empty">
            <p>No messages yet</p>
          </div>
        ` : `
          ${messages.map(m => `
            <div class="message ${m.fromMe ? 'sent' : 'received'}">
              ${!m.fromMe ? `<span class="author">${m.author || 'Unknown'}</span>` : ''}
              <div class="text">${escapeHtml(m.data?.text || m.text)}</div>
              <div class="time">${formatTime(m.timestamp)}</div>
            </div>
          `).join('')}
        `}
      </div>

      <form id="message-form" class="message-input">
        <input
          type="text"
          id="message-text"
          placeholder="Message ${escapeHtml(groupName)}..."
          autocomplete="off"
          ${sending ? 'disabled' : ''}
        />
        <button type="submit" ${sending ? 'disabled' : ''}>${sending ? '...' : 'Send'}</button>
      </form>
    </div>
  `;
}

function escapeHtml(text) {
  if (!text) return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function formatTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function parseMembers(membersJson) {
  try {
    return JSON.parse(membersJson) || [];
  } catch {
    return [];
  }
}

/**
 * Resolve authorDeviceId to a username
 * @param {string} authorDeviceId - Device UUID of the author
 * @param {object} client - ObscuraClient instance
 * @returns {string} - Username or truncated ID
 */
function resolveAuthorName(authorDeviceId, client, profileMap = new Map()) {
  // Check if it's our own message
  if (authorDeviceId === client.deviceUUID) {
    return 'You';
  }

  // Check profile displayName first (from pre-loaded profiles)
  if (profileMap.has(authorDeviceId)) {
    return profileMap.get(authorDeviceId);
  }

  // Search through friends to find matching device
  if (client.friends && client.friends.friends) {
    for (const [username, data] of client.friends.friends) {
      if (data.devices) {
        for (const device of data.devices) {
          // Check both deviceUUID and serverUserId
          if (device.deviceUUID === authorDeviceId || device.serverUserId === authorDeviceId) {
            return username;
          }
        }
      }
    }
  }

  // Fallback: truncated ID
  return authorDeviceId?.slice(0, 8) || 'Unknown';
}

export async function mount(container, client, router, params) {
  const groupId = params.id;

  container.innerHTML = render({ loading: true });

  try {
    if (!client.group) {
      throw new Error('Group model not defined');
    }

    const group = await client.group.find(groupId);

    if (!group) {
      container.innerHTML = render({ group: null });
      return;
    }

    // Load profiles to get displayNames
    const profileMap = new Map();
    if (client.profile) {
      const profiles = await client.profile.where({}).exec();
      for (const p of profiles) {
        if (p.authorDeviceId && p.data?.displayName) {
          profileMap.set(p.authorDeviceId, p.data.displayName);
        }
      }
    }

    // Load messages
    messages = [];
    if (client.groupMessage) {
      messages = await client.groupMessage.where({
        'data.groupId': groupId
      }).orderBy('timestamp', 'asc').exec();

      // Mark which are from me and resolve author names
      messages = messages.map(m => ({
        ...m,
        fromMe: m.authorDeviceId === client.deviceUUID,
        author: resolveAuthorName(m.authorDeviceId, client, profileMap),
      }));
    }

    container.innerHTML = render({ group, messages });

    const form = container.querySelector('#message-form');
    const input = container.querySelector('#message-text');
    const messagesContainer = container.querySelector('#messages');

    const scrollToBottom = () => {
      messagesContainer.scrollTop = messagesContainer.scrollHeight;
    };

    // Send message
    form.addEventListener('submit', async (e) => {
      e.preventDefault();

      const text = input.value.trim();
      if (!text) return;

      input.value = '';

      // Optimistic UI
      messages.push({
        data: { text, groupId },
        fromMe: true,
        timestamp: Date.now()
      });
      container.innerHTML = render({ group, messages });
      scrollToBottom();

      try {
        await client.groupMessage.create({ groupId, text });
      } catch (err) {
        console.error('Failed to send:', err);
      }
    });

    // Listen for new messages
    const handleSync = (sync) => {
      if (sync.model === 'groupMessage') {
        // Refresh messages
        mount(container, client, router, params);
      }
    };

    client.on('modelSync', handleSync);

    scrollToBottom();
    router.updatePageLinks();

    cleanup = () => {
      client.off('modelSync', handleSync);
    };

  } catch (err) {
    container.innerHTML = `<div class="error">Failed to load group: ${err.message}</div>`;
  }
}

export function unmount() {
  if (cleanup) {
    cleanup();
    cleanup = null;
  }
}
