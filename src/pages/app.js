// Main mobile app with tabs
import client from '../api/client.js';
import gateway from '../api/gateway.js';
import { friendStore, FriendStatus } from '../lib/friendStore.js';
import { signalStore } from '../lib/signalStore.js';
import { sessionManager } from '../lib/sessionManager.js';
import { sessionResetManager } from '../lib/sessionResetManager.js';
import { replenishPreKeys } from '../lib/crypto.js';
import { logger } from '../lib/logger.js';
import { renderAuth } from './auth.js';
import { renderCamera } from './camera.js';
import { renderInbox } from './inbox.js';
import { renderLogs } from './logs.js';
import QRCode from 'qrcode';

// Initialize stores for a user - must be called after auth
function initStoresForUser(userId) {
  signalStore.init(userId);
  friendStore.init(userId);
  logger.init(userId);
}

export function renderApp(container, options = {}) {
  let currentTab = 'camera'; // 'camera', 'inbox', 'profile', 'logs'
  let friends = [];
  let pendingMessages = [];
  let isConnecting = false;
  let cameraInstance = null;
  let inboxInstance = null;
  let logsInstance = null;

  // Store pending friend ID if provided (for processing after auth)
  if (options.pendingFriendId) {
    sessionStorage.setItem('obscura_pending_friend', options.pendingFriendId);
  }

  // Check if authenticated
  if (!client.loadTokens() || !client.isAuthenticated()) {
    renderAuth(container, onAuthSuccess);
    return;
  }

  // Init stores with user ID from restored session
  const userId = client.getUserId();
  if (userId) {
    initStoresForUser(userId);
  }

  // Start the app
  init();

  async function init() {
    await loadFriends();
    await loadPendingMessages();
    await connectGateway(); // Server pushes queued messages on connect
    render();
    // Process any pending friend link after everything is initialized
    await processPendingFriendLink();
    // Replenish prekeys if running low (non-blocking)
    replenishPreKeys(client).catch(err => console.error('[PreKey] Replenishment failed:', err));
  }

  // ============================================================
  // UNIFIED MESSAGE PROCESSING
  // Same flow for REST (queued) and WebSocket (real-time)
  // ============================================================

  async function processEnvelope(envelope) {
    const correlationId = envelope._correlationId || logger.generateCorrelationId();
    let decryptedBytes;

    // Try to decrypt - may fail if sender has stale session
    try {
      decryptedBytes = await sessionManager.decrypt(
        envelope.sourceUserId,
        envelope.message.content,
        envelope.message.type,
        correlationId
      );
    } catch (err) {
      // Decryption failed - likely key mismatch or missing session
      console.log(`[App] Decryption failed for ${envelope.sourceUserId}:`, err.message);
      await logger.logReceiveError(envelope.id, envelope.sourceUserId, err, correlationId);

      // Check if we already tried to reset for this envelope (prevent loops)
      if (sessionResetManager.hasTriedEnvelope(envelope.id)) {
        console.log(`[App] Already tried reset for envelope ${envelope.id}, skipping`);
        return null; // Don't ack - let server redeliver later
      }

      sessionResetManager.markEnvelopeTried(envelope.id);

      // Initiate session reset protocol
      const resetStarted = await sessionResetManager.initiateReset(
        envelope.sourceUserId,
        'decryption_failed'
      );

      if (resetStarted) {
        console.log(`[App] Session reset initiated for ${envelope.sourceUserId}`);
        await logger.logSessionReset(envelope.sourceUserId, 'decryption_failed');
      }

      // Return null to NOT ack - server will redeliver after reset completes
      return null;
    }

    // Decode
    const clientMsg = gateway.decodeClientMessage(new Uint8Array(decryptedBytes));
    console.log('Processing message:', clientMsg.type, 'from:', envelope.sourceUserId);
    await logger.logReceiveDecode(envelope.sourceUserId, clientMsg.type, correlationId);

    // Route and persist
    if (clientMsg.type === 'SESSION_RESET') {
      // Handle session reset request
      await sessionResetManager.handleSessionReset(envelope.sourceUserId, clientMsg);
      // Refresh UI since friend list may have changed
      await loadFriends();
      if (inboxInstance) inboxInstance.render();
    } else if (clientMsg.type === 'FRIEND_REQUEST') {
      await handleFriendRequest(envelope.sourceUserId, clientMsg);
    } else if (clientMsg.type === 'FRIEND_RESPONSE') {
      await handleFriendResponse(envelope.sourceUserId, clientMsg);
    } else if (clientMsg.type === 'IMAGE' || clientMsg.type === 'TEXT') {
      await handleContentMessage(envelope.sourceUserId, clientMsg);
    }

    // Log receive complete
    await logger.logReceiveComplete(envelope.id, envelope.sourceUserId, clientMsg.type, correlationId);

    // Refresh UI
    await loadFriends();
    await loadPendingMessages();
    if (inboxInstance) inboxInstance.render();

    return envelope.id; // Return for acking
  }


  async function processPendingFriendLink() {
    const pendingFriendId = sessionStorage.getItem('obscura_pending_friend');
    if (!pendingFriendId) return;

    // Clear it immediately to prevent reprocessing
    sessionStorage.removeItem('obscura_pending_friend');

    // Validate UUID format
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(pendingFriendId)) {
      alert('Invalid friend link');
      redirectToHome();
      return;
    }

    // Check if it's our own ID
    if (pendingFriendId === client.getUserId()) {
      alert("That's your own friend link!");
      redirectToHome();
      return;
    }

    // Check if already a friend
    const existing = await friendStore.getFriend(pendingFriendId);
    if (existing) {
      if (existing.status === FriendStatus.ACCEPTED) {
        alert(`Already friends with ${existing.username}!`);
      } else {
        alert(`Friend request already ${existing.status === FriendStatus.PENDING_SENT ? 'sent' : 'received'}!`);
      }
      redirectToHome();
      return;
    }

    // Send friend request
    try {
      await sendFriendRequest(pendingFriendId);
      alert('Friend request sent!');
      await loadFriends();
      if (inboxInstance) inboxInstance.render();
    } catch (err) {
      console.error('Failed to send friend request:', err);
      alert('Failed to send friend request: ' + err.message);
    }

    redirectToHome();
  }

  function redirectToHome() {
    const base = import.meta.env.BASE_URL || '/';
    window.history.replaceState(null, '', base);
  }

  async function sendFriendRequest(targetUserId) {
    await gateway.loadProto();

    const username = localStorage.getItem('obscura_username') || 'Unknown';

    // Start logging the send flow
    const correlationId = logger.generateCorrelationId();
    await logger.logSendStart(targetUserId, 'FRIEND_REQUEST', correlationId);

    // Encode friend request message
    const clientMessageBytes = gateway.encodeClientMessage({
      type: 'FRIEND_REQUEST',
      text: '',
      username: username,
    });

    // Encrypt and send
    const encrypted = await sessionManager.encrypt(targetUserId, clientMessageBytes, correlationId);
    const protobufData = gateway.encodeOutgoingMessage(encrypted.body, encrypted.protoType);

    await client.sendMessage(targetUserId, protobufData, correlationId);

    // Add to local friend store as pending_sent
    await friendStore.addFriend(targetUserId, 'Unknown', FriendStatus.PENDING_SENT);
  }

  async function loadFriends() {
    try {
      friends = await friendStore.getAllFriends();
    } catch (err) {
      console.error('Failed to load friends:', err);
      friends = [];
    }
  }

  async function loadPendingMessages() {
    try {
      pendingMessages = await friendStore.getPendingMessages();
    } catch (err) {
      console.error('Failed to load pending messages:', err);
      pendingMessages = [];
    }
  }

  async function connectGateway() {
    if (gateway.isConnected() || isConnecting) return;

    isConnecting = true;
    try {
      await gateway.connect();
      setupGatewayListeners();
    } catch (err) {
      console.error('Gateway connection failed:', err);
    } finally {
      isConnecting = false;
    }
  }

  function setupGatewayListeners() {
    // Clear existing listeners to prevent accumulation on reconnect
    gateway.removeAllListeners('envelope');
    gateway.removeAllListeners('disconnected');

    gateway.on('envelope', async (envelope) => {
      console.log('Received real-time envelope from:', envelope.sourceUserId);
      try {
        const envelopeId = await processEnvelope(envelope);
        if (envelopeId) {
          gateway.acknowledge(envelopeId); // WebSocket ack AFTER success
          console.log('Processed and acked real-time message:', envelopeId);
        } else {
          console.log('Message processing deferred (reset in progress), not acking');
        }
      } catch (err) {
        console.error('Failed to process real-time message:', err);
        // Don't ack - server will redeliver
      }
    });

    gateway.on('disconnected', () => {
      console.log('Gateway disconnected');
    });
  }

  async function handleFriendRequest(fromUserId, msg) {
    // Check if we already have this friend
    const existing = await friendStore.getFriend(fromUserId);

    if (existing) {
      if (existing.status === FriendStatus.PENDING_SENT) {
        // We sent them a request and they sent us one - auto-accept!
        await friendStore.updateFriendStatus(fromUserId, FriendStatus.ACCEPTED);
        if (msg.username) {
          await friendStore.addFriend(fromUserId, msg.username, FriendStatus.ACCEPTED);
        }
      }
      // If already accepted or pending_received, ignore
    } else {
      // New friend request - PERSIST TO INDEXEDDB
      await friendStore.addFriend(fromUserId, msg.username || 'Unknown', FriendStatus.PENDING_RECEIVED);
    }
    // UI refresh handled by caller (processEnvelope)
  }

  async function handleFriendResponse(fromUserId, msg) {
    if (msg.accepted) {
      // Update to accepted - PERSIST TO INDEXEDDB
      const existing = await friendStore.getFriend(fromUserId);
      if (existing) {
        await friendStore.updateFriendStatus(fromUserId, FriendStatus.ACCEPTED);
        // Update username if provided
        if (msg.username && existing.username === 'Unknown') {
          await friendStore.addFriend(fromUserId, msg.username, FriendStatus.ACCEPTED);
        }
      }
    } else {
      // Request declined - remove from IndexedDB
      await friendStore.removeFriend(fromUserId);
    }
    // UI refresh handled by caller (processEnvelope)
  }

  async function handleContentMessage(fromUserId, msg) {
    // Check if from a friend
    const friend = await friendStore.getFriend(fromUserId);
    if (!friend || friend.status !== FriendStatus.ACCEPTED) {
      console.log('Message from non-friend, ignoring');
      return;
    }

    // Get image data - either from attachment or inline bytes
    let imageData = null;
    if (msg.attachmentId) {
      // Fetch attachment from server
      try {
        const imageBytes = await client.fetchAttachment(msg.attachmentId);
        const base64 = btoa(String.fromCharCode(...imageBytes));
        imageData = `data:${msg.mimeType || 'image/jpeg'};base64,${base64}`;
      } catch (err) {
        console.error('Failed to fetch attachment:', err);
        // Continue without image if attachment fetch fails
      }
    } else if (msg.imageData && msg.imageData.length > 0) {
      // Legacy: inline image bytes
      const base64 = btoa(String.fromCharCode(...msg.imageData));
      imageData = `data:${msg.mimeType || 'image/jpeg'};base64,${base64}`;
    }

    // PERSIST TO INDEXEDDB - user will see unread indicator and click to view
    console.log('Storing message from:', friend.username, '- user can click to view');
    await friendStore.addPendingMessage({
      fromUserId,
      type: msg.type,
      text: msg.text,
      imageData,
      mimeType: msg.mimeType,
      displayDuration: msg.displayDuration || 8,
      timestamp: msg.timestamp,
    });
    // UI refresh handled by caller (processEnvelope)
  }

  function onAuthSuccess() {
    init();
  }

  function render() {
    container.innerHTML = `
      <div class="app-container">
        <div class="app-content" id="app-content"></div>
        <nav class="app-nav">
          <button class="nav-btn ${currentTab === 'camera' ? 'active' : ''}" data-tab="camera">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/>
              <circle cx="12" cy="13" r="4"/>
            </svg>
            <span>Camera</span>
          </button>
          <button class="nav-btn ${currentTab === 'inbox' ? 'active' : ''}" data-tab="inbox">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/>
              <polyline points="22,6 12,13 2,6"/>
            </svg>
            <span>Inbox${pendingMessages.length > 0 ? ` (${pendingMessages.length})` : ''}</span>
          </button>
          <button class="nav-btn ${currentTab === 'profile' ? 'active' : ''}" data-tab="profile">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
              <circle cx="12" cy="7" r="4"/>
            </svg>
            <span>Profile</span>
          </button>
          <button class="nav-btn ${currentTab === 'logs' ? 'active' : ''}" data-tab="logs">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
              <polyline points="14 2 14 8 20 8"/>
              <line x1="16" y1="13" x2="8" y2="13"/>
              <line x1="16" y1="17" x2="8" y2="17"/>
              <polyline points="10 9 9 9 8 9"/>
            </svg>
            <span>Logs</span>
          </button>
        </nav>
      </div>
    `;

    attachNavListeners();
    renderCurrentTab();
  }

  function attachNavListeners() {
    container.querySelectorAll('.nav-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const tab = btn.dataset.tab;
        switchTab(tab);
      });
    });
  }

  function switchTab(tab) {
    // Cleanup previous tab
    if (cameraInstance && currentTab === 'camera') {
      cameraInstance.cleanup();
      cameraInstance = null;
    }
    if (logsInstance && currentTab === 'logs') {
      logsInstance.hide();
    }

    currentTab = tab;

    // Show logs if switching to it and instance exists
    if (tab === 'logs' && logsInstance) {
      logsInstance.show();
    } else {
      renderCurrentTab();
    }

    // Update nav active state
    container.querySelectorAll('.nav-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.tab === tab);
    });
  }

  function renderCurrentTab() {
    const content = container.querySelector('#app-content');
    if (!content) return;

    switch (currentTab) {
      case 'camera':
        cameraInstance = renderCamera(content, {
          onSwitchTab: switchTab,
          friends,
          refreshFriends: async () => {
            await loadFriends();
            if (cameraInstance) cameraInstance.render();
          },
        });
        break;

      case 'inbox':
        inboxInstance = renderInbox(content, {
          friends,
          pendingMessages,
          refreshFriends: async () => {
            await loadFriends();
            if (inboxInstance) inboxInstance.render();
          },
          refreshMessages: async () => {
            await loadPendingMessages();
          },
        });
        break;

      case 'profile':
        renderProfile(content);
        break;

      case 'logs':
        logsInstance = renderLogs(content);
        break;
    }
  }

  function renderProfile(content) {
    const userId = client.getUserId();
    const username = localStorage.getItem('obscura_username') || 'Unknown';

    const base = import.meta.env.BASE_URL || '/';
    const friendLink = `${window.location.origin}${base}add/${userId}`;

    content.innerHTML = `
      <div class="profile-view">
        <div class="profile-card">
          <div class="profile-username">@${username}</div>
          <div class="qr-container" id="qr-container"></div>
          <div class="profile-hint">Friends scan this to add you</div>
          <div id="user-id-display" style="margin-top: 1rem; padding: 0.5rem; background: var(--bg-tertiary); border-radius: 8px; font-size: 0.7rem; color: var(--text-muted); word-break: break-all; cursor: pointer;">
            ${userId}
          </div>
          <div class="profile-hint" style="font-size: 0.65rem; margin-top: 0.25rem;">Tap to copy your ID</div>
        </div>

        <button class="profile-btn" id="copy-link">
          <span class="profile-btn-icon">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
              <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
            </svg>
          </span>
          Copy Friend Link
        </button>

        <div class="profile-card" style="margin-top: 1rem;">
          <div class="profile-hint" style="margin-bottom: 0.75rem;">Add friend by ID</div>
          <div style="display: flex; gap: 0.5rem;">
            <input
              type="text"
              id="friend-id-input"
              placeholder="Paste friend's ID"
              class="auth-input"
              style="flex: 1; margin: 0;"
            >
            <button class="profile-btn" id="add-friend-btn" style="width: auto; padding: 0 1rem;">
              Add
            </button>
          </div>
        </div>

        <button class="profile-btn danger" id="logout">
          <span class="profile-btn-icon">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
              <polyline points="16 17 21 12 16 7"/>
              <line x1="21" y1="12" x2="9" y2="12"/>
            </svg>
          </span>
          Logout
        </button>
      </div>
    `;

    // Generate QR code directly
    const qrContainer = content.querySelector('#qr-container');
    QRCode.toCanvas(userId, {
      width: 200,
      margin: 0,
      color: {
        dark: '#000000',
        light: '#ffffff',
      },
    }, (err, canvas) => {
      if (err) {
        console.error('QR generation error:', err);
        qrContainer.innerHTML = '<div style="color: var(--danger);">Failed to generate QR</div>';
        return;
      }
      qrContainer.appendChild(canvas);
    });

    // Copy user ID when tapped
    content.querySelector('#user-id-display')?.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(userId);
        const el = content.querySelector('#user-id-display');
        const original = el.textContent;
        el.textContent = 'Copied!';
        setTimeout(() => {
          el.textContent = original;
        }, 1500);
      } catch (err) {
        console.error('Failed to copy:', err);
      }
    });

    // Copy link button
    content.querySelector('#copy-link')?.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(friendLink);
        const btn = content.querySelector('#copy-link');
        const originalText = btn.innerHTML;
        btn.innerHTML = `<span class="profile-btn-icon">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="20 6 9 17 4 12"/>
          </svg>
        </span>Copied!`;
        setTimeout(() => {
          btn.innerHTML = originalText;
        }, 2000);
      } catch (err) {
        console.error('Failed to copy:', err);
        alert('Failed to copy link');
      }
    });

    // Add friend by ID
    content.querySelector('#add-friend-btn')?.addEventListener('click', async () => {
      const input = content.querySelector('#friend-id-input');
      const friendId = input.value.trim();

      if (!friendId) {
        alert('Please enter a friend ID');
        return;
      }

      // Validate UUID format
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (!uuidRegex.test(friendId)) {
        alert('Invalid ID format');
        return;
      }

      if (friendId === userId) {
        alert("That's your own ID!");
        return;
      }

      // Check if already a friend
      const existing = await friendStore.getFriend(friendId);
      if (existing) {
        if (existing.status === FriendStatus.ACCEPTED) {
          alert(`Already friends with ${existing.username}!`);
        } else {
          alert('Friend request already pending!');
        }
        return;
      }

      try {
        await sendFriendRequest(friendId);
        input.value = '';
        alert('Friend request sent!');
        await loadFriends();
      } catch (err) {
        console.error('Failed to send friend request:', err);
        alert('Failed to send friend request: ' + err.message);
      }
    });

    // Logout button
    content.querySelector('#logout')?.addEventListener('click', async () => {
      if (confirm('Are you sure you want to logout?')) {
        gateway.disconnect();
        await client.logout();
        // Keys persist in IndexedDB - user can receive messages sent while logged out
        // Friends also persist - they'll be here when the user logs back in
        renderAuth(container, onAuthSuccess);
      }
    });
  }
}
