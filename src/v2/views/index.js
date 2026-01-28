/**
 * V2 Views - Router and View Management
 */
import Navigo from 'navigo';

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
  client = obscuraClient;

  router = new Navigo('/');

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

  // Messaging routes
  router.on('/messages', () => requireAuth(() => mountView(ConversationList)));
  router.on('/messages/:username', ({ data }) => requireAuth(() => mountView(Chat, data)));

  // Stories routes
  router.on('/stories', () => requireAuth(() => mountView(StoryFeed)));
  router.on('/stories/new', () => requireAuth(() => mountView(CreateStory)));
  router.on('/stories/:id', ({ data }) => requireAuth(() => mountView(StoryDetail, data)));

  // Profile routes
  router.on('/profile', () => requireAuth(() => mountView(ViewProfile)));
  router.on('/profile/:username', ({ data }) => requireAuth(() => mountView(ViewProfile, data)));
  router.on('/profile/edit', () => requireAuth(() => mountView(EditProfile)));

  // Settings route
  router.on('/settings', () => requireAuth(() => mountView(Settings)));

  // Device routes
  router.on('/devices', () => requireAuth(() => mountView(DeviceList)));
  router.on('/devices/revoke/:deviceId', ({ data }) => requireAuth(() => mountView(RevokeDevice, data)));

  // Group routes
  router.on('/groups', () => requireAuth(() => mountView(GroupList)));
  router.on('/groups/new', () => requireAuth(() => mountView(CreateGroup)));
  router.on('/groups/:id', ({ data }) => requireAuth(() => mountView(GroupChat, data)));

  // Default route
  router.on('/', () => {
    if (client) {
      router.navigate('/stories');
    } else {
      router.navigate('/login');
    }
  });

  router.notFound(() => {
    container.innerHTML = '<div class="view error">Page not found</div>';
  });

  router.resolve();
}

/**
 * Set the authenticated client
 * @param {Object} obscuraClient
 */
export function setClient(obscuraClient) {
  client = obscuraClient;
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
  client.on('friendRequest', (req) => {
    // Could show a toast/badge
    console.log('Friend request from:', req.username);
  });

  // Friend response
  client.on('friendResponse', (resp) => {
    console.log('Friend response:', resp.accepted ? 'accepted' : 'rejected');
  });

  // Incoming message
  client.on('message', (msg) => {
    console.log('Message from:', msg.from);
  });

  // Device announce
  client.on('deviceAnnounce', (announce) => {
    console.log('Device announce:', announce.isRevocation ? 'revocation' : 'update');
  });

  // Model sync
  client.on('modelSync', (sync) => {
    console.log('Model sync:', sync.model, sync.id);
  });
}
