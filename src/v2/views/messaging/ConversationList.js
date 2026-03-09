/**
 * ConversationList View
 * - List friends as conversations
 * - Show last message preview (if available)
 * - Tap → Chat view
 */
import { navigate, clearClient, getBadgeCounts, hasUnreadMessages } from '../index.js';
import { renderNav, initNav } from '../components/Nav.js';
import { ObscuraClient } from '../../lib/ObscuraClient.js';

let cleanup = null;

function renderSmallAvatar(avatarUrl, name) {
  if (avatarUrl) {
    return `<img class="avatar-sm" src="${avatarUrl}" alt="" />`;
  }
  const letter = (name || 'U')[0].toUpperCase();
  return `<div class="avatar-sm-placeholder">${letter}</div>`;
}

export function render({ conversations = [], pendingRequests = 0 } = {}) {
  return `
    <div class="view conversation-list">
      <header>
        <h1>Chats</h1>
        <a href="/friends/add" data-navigo><button variant="ghost" size="sm"><ry-icon name="plus"></ry-icon></button></a>
      </header>

      ${pendingRequests > 0 ? `
        <a href="/friends/requests" data-navigo class="pending-banner">
          <card variant="primary" style="margin-bottom: var(--ry-space-3)">
            <cluster>
              <ry-icon name="user"></ry-icon>
              <span>${pendingRequests} pending friend request${pendingRequests > 1 ? 's' : ''}</span>
              <ry-icon name="chevron-right"></ry-icon>
            </cluster>
          </card>
        </a>
      ` : ''}

      ${conversations.length === 0 ? `
        <div class="empty">
          <p>No conversations yet</p>
          <a href="/friends/add" data-navigo><button>Add a Friend</button></a>
        </div>
      ` : `
        <stack gap="sm" class="conversation-items">
          ${conversations.map(c => `
            <card class="conversation-item" data-username="${c.username}" data-type="${c.type || 'dm'}" data-group-id="${c.groupId || ''}" style="position: relative;">
              <cluster>
                ${c.type === 'group'
                  ? `<div class="avatar-sm-placeholder"><ry-icon name="star" style="font-size: 16px"></ry-icon></div>`
                  : renderSmallAvatar(c.avatarUrl, c.displayName || c.username)}
                <stack gap="none" style="flex: 1">
                  <strong>${c.displayName || c.username}</strong>
                  ${c.lastMessage ? `
                    <span style="color: var(--ry-color-text-muted); font-size: var(--ry-text-sm)">${c.lastMessage}</span>
                  ` : `
                    <span style="color: var(--ry-color-text-muted); font-size: var(--ry-text-sm); font-style: italic">No messages yet</span>
                  `}
                </stack>
                <ry-icon name="chevron-right"></ry-icon>
              </cluster>
              ${c.unread ? `<span class="unread-dot"></span>` : ''}
            </card>
          `).join('')}
        </stack>
      `}

      ${renderNav('chats', getBadgeCounts())}
    </div>
  `;
}

export async function mount(container, client, router) {
  const conversations = [];
  let pendingRequests = 0;

  // Load profiles to get displayNames and avatars
  const profileMap = new Map();  // deviceId -> { displayName, avatarUrl }
  if (client.profile) {
    try {
      const profiles = await client.profile.where({}).exec();
      for (const p of profiles) {
        if (p.authorDeviceId && p.data) {
          profileMap.set(p.authorDeviceId, {
            displayName: p.data.displayName || null,
            avatarUrl: p.data.avatarUrl || null,
          });
        }
      }
    } catch (err) {
      console.warn('Failed to load profiles:', err);
    }
  }

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

        // Look up display name and avatar from profiles using friend's deviceUUID
        let displayName = null;
        let avatarUrl = null;
        if (data.devices) {
          for (const device of data.devices) {
            if (device.deviceUUID && profileMap.has(device.deviceUUID)) {
              const profileData = profileMap.get(device.deviceUUID);
              displayName = profileData.displayName;
              avatarUrl = profileData.avatarUrl;
              break;
            }
          }
        }

        // Check for unread messages
        const unread = await hasUnreadMessages(username);

        conversations.push({
          username,
          displayName,
          avatarUrl,
          lastMessage,
          type: 'dm',
          unread
        });
      } else if (data.status === 'pending_incoming') {
        pendingRequests++;
      }
    }
  }

  // Add groups to conversations list
  if (client.group) {
    try {
      const groups = await client.group.where({}).exec();
      for (const group of groups) {
        // Get last message for this group
        let lastMessage = null;
        try {
          const messages = await client.groupMessage.where({ 'data.groupId': group.id })
            .orderBy('timestamp', 'desc')
            .limit(1)
            .exec();
          if (messages.length > 0) {
            const last = messages[0];
            const text = last.data?.text || (last.data?.mediaUrl ? '[Attachment]' : '');
            lastMessage = text.length > 40 ? text.slice(0, 40) + '...' : text;
            // Prefix with author if not self
            if (last.authorDeviceId !== client.deviceUUID) {
              // Prefer profile displayName, fall back to authorUsername
              const authorProfile = profileMap.get(last.authorDeviceId);
              const authorName = authorProfile?.displayName || last.data?.authorUsername || 'Someone';
              lastMessage = `${authorName}: ${lastMessage}`;
            } else {
              lastMessage = 'You: ' + lastMessage;
            }
          }
        } catch (err) {
          console.warn('Failed to load group messages for', group.id, err);
        }

        conversations.push({
          username: group.data?.name || 'Unnamed Group',
          groupId: group.id,
          lastMessage,
          type: 'group',
          timestamp: group.timestamp,
          unread: 0
        });
      }
    } catch (err) {
      console.warn('Failed to load groups:', err);
    }
  }

  // Sort conversations by most recent activity
  conversations.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

  container.innerHTML = render({ conversations, pendingRequests });

  // Click handlers
  const items = container.querySelectorAll('.conversation-item');
  items.forEach(item => {
    item.addEventListener('click', (e) => {
      e.preventDefault();
      const type = item.dataset.type;
      const username = item.dataset.username;

      if (type === 'group') {
        const groupId = item.dataset.groupId;
        navigate(`/groups/${groupId}`);
      } else {
        navigate(`/messages/${username}`);
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
