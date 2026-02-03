/**
 * V2 Views - Router and View Management
 */
import Navigo from 'navigo';
import { updatePixBadge, updateChatsBadge } from './components/Nav.js';

/**
 * Get the API URL - uses proxy in dev to avoid CORS
 */
export function getApiUrl() {
  return import.meta.env.DEV ? '/api' : import.meta.env.VITE_API_URL;
}

/**
 * Get the WebSocket URL - uses /ws proxy in dev
 */
export function getWsUrl() {
  return import.meta.env.DEV ? '/ws' : import.meta.env.VITE_API_URL?.replace('https://', 'wss://');
}

// View imports
import * as Register from './auth/Register.js';
import * as Login from './auth/Login.js';
import * as Recover from './auth/Recover.js';
import * as LinkPending from './auth/LinkPending.js';
import * as LinkNewDevice from './auth/LinkNewDevice.js';

import * as FriendList from './friends/FriendList.js';
import * as AddFriend from './friends/AddFriend.js';
import * as FriendRequests from './friends/FriendRequests.js';
import * as VerifyCode from './friends/VerifyCode.js';

import * as ConversationList from './messaging/ConversationList.js';
import * as Chat from './messaging/Chat.js';

import * as PixList from './pix/PixList.js';
import * as PixCamera from './pix/PixCamera.js';
import * as PixViewer from './pix/PixViewer.js';

import * as StoryFeed from './stories/StoryFeed.js';
import * as CreateStory from './stories/CreateStory.js';
import * as StoryDetail from './stories/StoryDetail.js';

import * as ViewProfile from './profile/ViewProfile.js';
import * as EditProfile from './profile/EditProfile.js';

import * as Settings from './settings/Settings.js';

import * as DeviceList from './devices/DeviceList.js';
import * as RevokeDevice from './devices/RevokeDevice.js';

import * as GroupList from './groups/GroupList.js';
import * as CreateGroup from './groups/CreateGroup.js';
import * as GroupChat from './groups/GroupChat.js';

import * as Logs from './logs/Logs.js';

let router = null;
let currentView = null;
let container = null;
let client = null;
let badgeCounts = { pix: 0, chats: 0 };

/**
 * Initialize the router and views
 * @param {HTMLElement} appContainer - The main app container element
 * @param {Object} obscuraClient - The Obscura client instance (null if not logged in)
 */
export function init(appContainer, obscuraClient = null) {
  container = appContainer;

  // Use setClient to properly set client and expose on window
  if (obscuraClient) {
    setClient(obscuraClient);
  } else {
    client = null;
  }

  router = new Navigo(import.meta.env.BASE_URL || '/');

  // Auth routes (no client required)
  router.on('/register', () => mountView(Register));
  router.on('/login', () => mountView(Login));
  router.on('/recover', () => mountView(Recover));
  router.on('/link-pending', () => mountView(LinkPending));
  router.on('/link-device', () => requireAuth(() => mountView(LinkNewDevice)));

  // Friends routes
  router.on('/friends', () => requireAuth(() => mountView(FriendList)));
  router.on('/friends/add', () => requireAuth(() => mountView(AddFriend)));
  router.on('/friends/requests', () => requireAuth(() => mountView(FriendRequests)));
  router.on('/friends/verify/:username', ({ data }) => requireAuth(() => mountView(VerifyCode, data)));

  // Chats routes (main conversation view)
  router.on('/chats', () => requireAuth(() => mountView(ConversationList)));
  router.on('/messages', () => requireAuth(() => mountView(ConversationList))); // Alias for backwards compat
  router.on('/messages/:username', ({ data }) => requireAuth(() => mountView(Chat, data)));

  // Pix routes
  router.on('/pix', () => requireAuth(() => mountView(PixList)));
  router.on('/pix/camera', () => requireAuth(() => mountView(PixCamera)));
  router.on('/pix/view/:username', ({ data }) => requireAuth(() => mountView(PixViewer, data)));

  // Stories routes
  router.on('/stories', () => requireAuth(() => mountView(StoryFeed)));
  router.on('/stories/new', () => requireAuth(() => mountView(CreateStory)));
  router.on('/stories/:id', ({ data }) => requireAuth(() => mountView(StoryDetail, data)));

  // Profile routes
  router.on('/profile', () => requireAuth(() => mountView(ViewProfile)));
  router.on('/profile/edit', () => requireAuth(() => mountView(EditProfile)));
  router.on('/profile/:username', ({ data }) => requireAuth(() => mountView(ViewProfile, data)));

  // Settings route
  router.on('/settings', () => requireAuth(() => mountView(Settings)));

  // Device routes
  router.on('/devices', () => requireAuth(() => mountView(DeviceList)));
  router.on('/devices/revoke/:deviceId', ({ data }) => requireAuth(() => mountView(RevokeDevice, data)));

  // Group routes
  router.on('/groups', () => requireAuth(() => mountView(GroupList)));
  router.on('/groups/new', () => requireAuth(() => mountView(CreateGroup)));
  router.on('/groups/:id', ({ data }) => requireAuth(() => mountView(GroupChat, data)));

  // Logs route
  router.on('/logs', () => requireAuth(() => mountView(Logs)));

  // Default route - show pix if logged in, otherwise login
  router.on('/', () => {
    if (client) {
      mountView(PixList);
    } else {
      mountView(Login);
    }
  });

  router.notFound(() => {
    // Default to login for any unknown route
    if (client) {
      mountView(StoryFeed);
    } else {
      mountView(Login);
    }
  });

  // Handle GitHub Pages SPA redirect (404.html encodes path as ?p=)
  const params = new URLSearchParams(window.location.search);
  const redirectPath = params.get('p');
  if (redirectPath) {
    // Restore the original path and remove query param
    const base = import.meta.env.BASE_URL || '/';
    history.replaceState(null, '', base + redirectPath.replace(/^\//, ''));
  }

  router.resolve();
}

/**
 * Set the authenticated client
 * @param {Object} obscuraClient
 */
export function setClient(obscuraClient) {
  client = obscuraClient;
  // Expose for testing in dev mode
  if (typeof window !== 'undefined') {
    window.__client = obscuraClient;
  }
  setupGlobalEventHandlers();
}

/**
 * Clear the client (logout)
 */
export function clearClient() {
  client = null;
  router.navigate('/login');
}

/**
 * Navigate to a route
 * @param {string} path
 */
export function navigate(path) {
  router.navigate(path);
}

/**
 * Get the current client
 */
export function getClient() {
  return client;
}

/**
 * Get the router instance
 */
export function getRouter() {
  return router;
}

/**
 * Get current badge counts for nav
 */
export function getBadgeCounts() {
  return badgeCounts;
}

// --- Private helpers ---

function requireAuth(callback) {
  if (!client) {
    router.navigate('/login');
    return;
  }
  callback();
}

function mountView(view, params = {}) {
  // Reset ready flag before mounting (for tests)
  if (typeof window !== 'undefined') {
    window.__viewReady = false;
  }

  // Unmount current view
  if (currentView && currentView.unmount) {
    currentView.unmount();
  }

  currentView = view;

  // Mount new view
  if (view.mount) {
    view.mount(container, client, router, params);
  } else {
    // Fallback: just render
    container.innerHTML = view.render ? view.render(params) : '';
  }

  // Set ready flag after mounting (for tests)
  if (typeof window !== 'undefined') {
    window.__viewReady = true;
  }
}

/**
 * Refresh the pix badge count
 */
export async function refreshPixBadge() {
  if (!client?.pix) return;
  try {
    const allPix = await client.pix.all();
    const unviewedCount = allPix.filter(p =>
      p.data?.recipientUsername === client.username &&
      !p.data?.viewedAt &&
      !p.data?._deleted
    ).length;
    badgeCounts.pix = unviewedCount;
    updatePixBadge(unviewedCount);
    // Retry if nav wasn't ready
    if (!document.querySelector('.bottom-nav') && unviewedCount > 0) {
      setTimeout(() => updatePixBadge(unviewedCount), 500);
    }
  } catch (err) {
    console.error('[Global] Failed to refresh pix badge:', err);
  }
}

/**
 * Get last read timestamp for a conversation
 */
function getLastRead(conversationId) {
  const key = `lastRead_${client?.username}_${conversationId}`;
  const val = localStorage.getItem(key);
  return val ? parseInt(val, 10) : 0;
}

/**
 * Mark a conversation as read (call when opening a chat)
 */
export function markConversationRead(conversationId) {
  if (!client?.username) return;
  const key = `lastRead_${client.username}_${conversationId}`;
  localStorage.setItem(key, Date.now().toString());
  refreshChatsBadge();
}

/**
 * Check if a conversation has unread messages
 */
export async function hasUnreadMessages(conversationId) {
  if (!client?.getMessages) return false;
  try {
    const lastRead = getLastRead(conversationId);
    const messages = await client.getMessages(conversationId);
    return messages.some(m => m.timestamp > lastRead && !m.isSent);
  } catch {
    return false;
  }
}

/**
 * Refresh the chats badge count
 */
export async function refreshChatsBadge() {
  if (!client?.getMessages) return;
  try {
    // Get all conversations from friends
    const friends = client.friends.getAll();
    let unreadConversations = 0;

    for (const friend of friends) {
      if (friend.status !== 'accepted') continue;
      const conversationId = friend.username;
      const lastRead = getLastRead(conversationId);
      const messages = await client.getMessages(conversationId);

      // Check if any message is newer than lastRead and not from us
      const hasUnread = messages.some(m =>
        m.timestamp > lastRead && !m.isSent
      );
      if (hasUnread) unreadConversations++;
    }

    badgeCounts.chats = unreadConversations;
    updateChatsBadge(unreadConversations);
    // Retry if nav wasn't ready
    if (!document.querySelector('.bottom-nav') && unreadConversations > 0) {
      setTimeout(() => updateChatsBadge(unreadConversations), 500);
    }
  } catch (err) {
    console.error('[Global] Failed to refresh chats badge:', err);
  }
}

function setupGlobalEventHandlers() {
  if (!client) return;

  // Initial badge refresh
  refreshPixBadge();
  refreshChatsBadge();

  // Friend request notification
  // Note: FriendManager.processRequest() already stores the request
  client.on('friendRequest', (req) => {
    console.log('[Global] Friend request from:', req.username);
    // Show toast if available
    if (typeof RyToast !== 'undefined') {
      RyToast.info(`Friend request from ${req.username}`);
    }
  });

  // Friend response
  client.on('friendResponse', (resp) => {
    console.log('[Global] Friend response:', resp.accepted ? 'accepted' : 'rejected', 'from', resp.username);
    if (typeof RyToast !== 'undefined') {
      if (resp.accepted) {
        RyToast.success(`${resp.username} accepted your friend request!`);
      } else {
        RyToast.info(`${resp.username} declined your friend request`);
      }
    }
  });

  // Incoming message
  client.on('message', (msg) => {
    console.log('[Global] Message from:', msg.sourceUserId || msg.from);
    if (typeof RyToast !== 'undefined') {
      const from = msg.conversationId || client.friends.getUsernameFromServerId(msg.sourceUserId) || msg.sourceUserId;
      RyToast.info(`New message from ${from}`);
    }
    refreshChatsBadge();
  });

  // Device announce - auto-apply to update friend device lists
  client.on('deviceAnnounce', async (announce) => {
    console.log('[Global] Device announce:', announce.isRevocation ? 'revocation' : 'update');
    try {
      await announce.apply();
      console.log('[Global] Device announce applied');
    } catch (err) {
      console.error('[Global] Failed to apply device announce:', err);
    }
  });

  // Model sync - show toasts for relevant models
  client.on('modelSync', (sync) => {
    console.log('[Global] Model sync:', sync.model, sync.id);
    if (typeof RyToast !== 'undefined') {
      // Skip self-syncs (from own devices)
      if (sync.sourceUserId === client.userId) return;

      switch (sync.model) {
        case 'story':
          // Only toast for new stories (op=0 is create), not updates/deletes
          if (sync.op === 0 && !sync.data?._deleted) {
            const storyAuthor = client.friends.getUsernameFromServerId(sync.sourceUserId) || sync.sourceUserId;
            RyToast.info(`New story from ${storyAuthor}`);
          }
          break;
        case 'pix':
          // Only toast for new pix where I'm the recipient (not view updates)
          if (sync.data?.recipientUsername === client.username && !sync.data?.viewedAt) {
            const pixSender = client.friends.getUsernameFromServerId(sync.sourceUserId) || sync.sourceUserId;
            RyToast.info(`New pix from ${pixSender}`);
          }
          refreshPixBadge();
          break;
        case 'groupMessage':
          const groupMsgSender = client.friends.getUsernameFromServerId(sync.sourceUserId) || sync.sourceUserId;
          // Look up group name
          if (sync.data?.groupId && client.group) {
            client.group.find(sync.data.groupId).then(group => {
              const groupName = group?.data?.name || 'group';
              RyToast.info(`${groupMsgSender} in ${groupName}`);
            }).catch(() => {
              RyToast.info(`New group message from ${groupMsgSender}`);
            });
          } else {
            RyToast.info(`New group message from ${groupMsgSender}`);
          }
          break;
      }
    }
  });

  // Sent sync - log when messages are synced from other devices
  client.on('sentSync', (sync) => {
    console.log('[Global] Sent sync:', sync.conversationId, sync.messageId);
  });

  // Sync blob - log when full state is received (device linking)
  client.on('syncBlob', () => {
    console.log('[Global] Sync blob received');
  });

  // Connection events
  client.on('disconnect', () => {
    console.log('[Global] Disconnected from server');
  });

  client.on('reconnect', () => {
    console.log('[Global] Reconnected to server');
  });

  client.on('error', (err) => {
    console.error('[Global] Client error:', err);
  });

  // Device revocation (self-brick)
  client.on('deviceRevoked', async ({ revokedBy, reason }) => {
    console.warn('[Global] This device has been revoked:', reason);

    // Import unlinkDevice dynamically to avoid circular imports
    const { unlinkDevice } = await import('../lib/auth.js');
    const { ObscuraClient } = await import('../lib/ObscuraClient.js');

    // Store username/userId before disconnect
    const username = client.username;
    const userId = client.userId;

    // Disconnect WebSocket
    client.disconnect();

    // Close all IndexedDB connections
    if (client.store?.close) client.store.close();
    if (client._friendStore?.close) client._friendStore.close();
    if (client._deviceStore?.close) client._deviceStore.close();
    if (client.messageStore?.close) client.messageStore.close();
    if (client._attachmentStore?.close) client._attachmentStore.close();

    // Wipe all local data
    await unlinkDevice(username, userId);

    // Clear session
    ObscuraClient.clearSession();
    clearClient();

    // Show alert and redirect
    alert('This device has been revoked. All local data has been erased.');
    navigate('/login');
  });
}
