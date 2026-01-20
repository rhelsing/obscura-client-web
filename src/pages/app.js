// Main mobile app with tabs
import client from '../api/client.js';
import gateway from '../api/gateway.js';
import { clearKeys } from '../lib/crypto.js';
import { friendStore, FriendStatus } from '../lib/friendStore.js';
import { sessionManager } from '../lib/sessionManager.js';
import { renderAuth } from './auth.js';
import { renderCamera } from './camera.js';
import { renderInbox } from './inbox.js';
import QRCode from 'qrcode';

export function renderApp(container, options = {}) {
  let currentTab = 'camera'; // 'camera', 'inbox', 'profile'
  let friends = [];
  let pendingMessages = [];
  let isConnecting = false;
  let cameraInstance = null;
  let inboxInstance = null;

  // Store pending friend ID if provided (for processing after auth)
  if (options.pendingFriendId) {
    sessionStorage.setItem('obscura_pending_friend', options.pendingFriendId);
  }

  // Check if authenticated
  if (!client.loadTokens() || !client.isAuthenticated()) {
    renderAuth(container, onAuthSuccess);
    return;
  }

  // Start the app
  init();

  async function init() {
    await loadFriends();
    await loadPendingMessages();
    await connectGateway();
    render();
    // Process any pending friend link after everything is initialized
    await processPendingFriendLink();
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

    // Encode friend request message
    const clientMessageBytes = gateway.encodeClientMessage({
      type: 'FRIEND_REQUEST',
      text: '',
      username: username,
    });

    // Encrypt and send
    const encrypted = await sessionManager.encrypt(targetUserId, clientMessageBytes);
    const protobufData = gateway.encodeOutgoingMessage(encrypted.body, encrypted.protoType);

    await client.sendMessage(targetUserId, protobufData);

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
    gateway.on('envelope', async (envelope) => {
      console.log('Received envelope from:', envelope.sourceUserId);
      await handleIncomingMessage(envelope);
    });

    gateway.on('disconnected', () => {
      console.log('Gateway disconnected');
    });
  }

  async function handleIncomingMessage(envelope) {
    try {
      // Decrypt message
      const decryptedBytes = await sessionManager.decrypt(
        envelope.sourceUserId,
        envelope.message.content,
        envelope.message.type
      );

      // Decode client message
      const clientMsg = gateway.decodeClientMessage(new Uint8Array(decryptedBytes));
      console.log('Decoded message:', clientMsg.type, clientMsg);

      // Handle based on message type
      if (clientMsg.type === 'FRIEND_REQUEST') {
        await handleFriendRequest(envelope.sourceUserId, clientMsg);
      } else if (clientMsg.type === 'FRIEND_RESPONSE') {
        await handleFriendResponse(envelope.sourceUserId, clientMsg);
      } else if (clientMsg.type === 'IMAGE' || clientMsg.type === 'TEXT') {
        await handleContentMessage(envelope.sourceUserId, clientMsg);
      }
    } catch (err) {
      console.error('Failed to handle incoming message:', err);
    }
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
      // New friend request
      await friendStore.addFriend(fromUserId, msg.username || 'Unknown', FriendStatus.PENDING_RECEIVED);
    }

    await loadFriends();
    if (inboxInstance) inboxInstance.render();
  }

  async function handleFriendResponse(fromUserId, msg) {
    if (msg.accepted) {
      // Update to accepted
      const existing = await friendStore.getFriend(fromUserId);
      if (existing) {
        await friendStore.updateFriendStatus(fromUserId, FriendStatus.ACCEPTED);
        // Update username if provided
        if (msg.username && existing.username === 'Unknown') {
          await friendStore.addFriend(fromUserId, msg.username, FriendStatus.ACCEPTED);
        }
      }
    } else {
      // Request declined - remove
      await friendStore.removeFriend(fromUserId);
    }

    await loadFriends();
    if (inboxInstance) inboxInstance.render();
  }

  async function handleContentMessage(fromUserId, msg) {
    // Check if from a friend
    const friend = await friendStore.getFriend(fromUserId);
    if (!friend || friend.status !== FriendStatus.ACCEPTED) {
      console.log('Message from non-friend, ignoring');
      return;
    }

    // Convert image data to data URL if present
    let imageData = null;
    if (msg.imageData && msg.imageData.length > 0) {
      const base64 = btoa(String.fromCharCode(...msg.imageData));
      imageData = `data:${msg.mimeType || 'image/jpeg'};base64,${base64}`;
    }

    // Store as pending message
    await friendStore.addPendingMessage({
      fromUserId,
      type: msg.type,
      text: msg.text,
      imageData,
      mimeType: msg.mimeType,
      displayDuration: msg.displayDuration || 8,
      timestamp: msg.timestamp,
    });

    await loadPendingMessages();
    if (inboxInstance) inboxInstance.render();
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

    currentTab = tab;
    renderCurrentTab();

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

    // Logout button
    content.querySelector('#logout')?.addEventListener('click', async () => {
      if (confirm('Are you sure you want to logout?')) {
        gateway.disconnect();
        await client.logout();
        clearKeys();
        await friendStore.clearAll();
        renderAuth(container, onAuthSuccess);
      }
    });
  }
}
