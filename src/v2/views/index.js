/**
 * V2 Views - Router and View Management
 */
import Navigo from 'navigo';

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

// --- Private helpers ---

function requireAuth(callback) {
  if (!client) {
    router.navigate('/login');
    return;
  }
  callback();
}

function mountView(view, params = {}) {
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
}

function setupGlobalEventHandlers() {
  if (!client) return;

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

  // Incoming message - just log, views handle their own display
  client.on('message', (msg) => {
    console.log('[Global] Message from:', msg.sourceUserId || msg.from);
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

  // Model sync - just log, ORM handles via _ormSyncManager
  client.on('modelSync', (sync) => {
    console.log('[Global] Model sync:', sync.model, sync.id);
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
    if (typeof RyToast !== 'undefined') {
      RyToast.success('Reconnected');
    }
  });

  client.on('error', (err) => {
    console.error('[Global] Client error:', err);
  });
}
