import client from '../api/client.js';
import gateway from '../api/gateway.js';
import { generateRegistrationKeys, storeKeys, storeGeneratedKeys } from '../lib/crypto.js';
import { sessionManager } from '../lib/sessionManager.js';
import { signalStore } from '../lib/signalStore.js';
import { friendStore } from '../lib/friendStore.js';
import { logger } from '../lib/logger.js';

// Initialize stores for a user - must be called after auth
function initStoresForUser(userId) {
  signalStore.init(userId);
  friendStore.init(userId);
  logger.init(userId);
}

// Convert Uint8Array to base64 without call stack overflow
function uint8ArrayToBase64(bytes) {
  let binary = '';
  const len = bytes.length;
  const chunkSize = 8192;
  for (let i = 0; i < len; i += chunkSize) {
    const chunk = bytes.subarray(i, Math.min(i + chunkSize, len));
    for (let j = 0; j < chunk.length; j++) {
      binary += String.fromCharCode(chunk[j]);
    }
  }
  return btoa(binary);
}

export function renderLanding(container, router) {
  const logs = [];
  const messages = []; // Store received messages
  let authMode = 'login';
  let isLoading = false;
  let isSending = false;
  let pendingImage = null; // { data: Uint8Array, mimeType: string, preview: string }
  let webcamActive = false;
  let webcamStream = null;
  let lastRecipient = ''; // Persist recipient UUID between sends

  function log(message, type = '') {
    const time = new Date().toLocaleTimeString('en-US', { hour12: false });
    logs.push({ time, message, type });
    if (logs.length > 50) logs.shift();
    render();
  }

  function render() {
    const isAuth = client.isAuthenticated();
    const wsConnected = gateway.isConnected();

    if (!isAuth) {
      container.innerHTML = `
        <div class="auth-screen">
          <div class="auth-logo">obscura</div>
          <div class="auth-subtitle" style="color: var(--text-muted); margin-bottom: 2rem; font-size: 0.875rem;">testing console</div>
          ${renderAuthForm()}
        </div>
      `;
    } else {
      container.innerHTML = `
        <div class="app-container">
          <header class="app-header">
            <span class="app-title">obscura testing</span>
            <div class="status-dot ${wsConnected ? 'connected' : 'disconnected'}"></div>
          </header>
          <div class="app-content">
            <div class="testing-view">
              ${renderLogPanel()}
              ${renderAuthenticatedUI(wsConnected)}
            </div>
          </div>
        </div>
      `;
    }

    attachEventListeners();
    scrollLogToBottom();
  }

  function renderLogPanel() {
    return `
      <div class="log-panel">
        <div class="log-header">
          <span class="log-title">Connection Log</span>
        </div>
        <div class="log-content" id="log">
          ${logs.length === 0 ? '<div class="log-entry">Ready to connect...</div>' : ''}
          ${logs.map(l => `
            <div class="log-entry ${l.type}">
              <span class="log-time">${l.time}</span>
              <span class="log-msg">${l.message}</span>
            </div>
          `).join('')}
        </div>
      </div>
    `;
  }

  function renderAuthForm() {
    return `
      <form id="auth-form" class="auth-form">
        <div class="auth-tabs">
          <button type="button" class="auth-tab ${authMode === 'login' ? 'active' : ''}" data-mode="login">Login</button>
          <button type="button" class="auth-tab ${authMode === 'register' ? 'active' : ''}" data-mode="register">Register</button>
        </div>
        <input type="text" id="username" name="username" class="auth-input" placeholder="Username" required autocomplete="username">
        <input type="password" id="password" name="password" class="auth-input" placeholder="Password" required autocomplete="current-password">
        <button type="submit" class="auth-btn" ${isLoading ? 'disabled' : ''}>
          ${isLoading ? 'Please wait...' : authMode === 'login' ? 'Connect' : 'Create Account'}
        </button>
      </form>
    `;
  }

  function renderAuthenticatedUI(wsConnected) {
    const userId = client.getUserId();
    const payload = client.getTokenPayload();

    return `
      <div class="session-card">
        <div class="session-header">Session</div>
        <div class="user-id-block">
          <div class="user-id-label">Your User ID</div>
          <div class="user-id-value" id="user-id">${userId || 'Unknown'}</div>
          <button class="copy-btn" id="copy-id">Copy</button>
        </div>
        <div class="session-meta">
          Token expires: ${new Date(client.expiresAt * 1000).toLocaleTimeString()}
        </div>
        <div class="session-actions">
          <button id="connect-ws" class="action-btn ${wsConnected ? 'connected' : ''}" ${wsConnected ? 'disabled' : ''}>
            ${wsConnected ? 'Gateway Connected' : 'Connect to Gateway'}
          </button>
          <button id="logout" class="action-btn danger">Logout</button>
        </div>
      </div>

      ${wsConnected ? renderMessaging() : ''}
    `;
  }

  function renderMessaging() {
    return `
      <div class="messaging-card">
        <div class="messaging-header">Messages</div>

        <div class="messages-list" id="messages-list">
          ${messages.length === 0
            ? '<div class="empty-messages">No messages yet</div>'
            : messages.map(m => renderMessage(m)).join('')
          }
        </div>

        <form id="send-form" class="send-form">
          <input type="text" id="recipient" name="recipient" class="auth-input" placeholder="Recipient UUID" value="${lastRecipient}" required>

          <div class="compose-area" id="compose-area">
            ${webcamActive ? renderWebcam() : ''}
            ${pendingImage ? renderImagePreview() : ''}
            ${!webcamActive && !pendingImage ? `
              <textarea id="message" name="message" class="message-input" rows="3" placeholder="Type your message or drop an image..."></textarea>
              <div class="compose-actions">
                <button type="button" id="webcam-btn" class="camera-btn" title="Take photo">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/>
                    <circle cx="12" cy="13" r="4"/>
                  </svg>
                </button>
                <button type="submit" class="send-btn" ${isSending ? 'disabled' : ''}>
                  ${isSending ? 'Sending...' : 'Send'}
                </button>
              </div>
            ` : ''}
          </div>
        </form>
      </div>
    `;
  }

  function renderMessage(m) {
    const isImage = m.type === 'IMAGE' && m.imageData;
    return `
      <div class="msg ${m.direction}">
        <div class="msg-meta">
          <span class="msg-user">${m.direction === 'in' ? m.from.slice(0, 8) + '...' : 'You → ' + m.to.slice(0, 8) + '...'}</span>
          <span class="msg-time">${m.time}</span>
        </div>
        ${isImage
          ? `<img class="msg-image" src="${m.imageData}" alt="Image">`
          : `<div class="msg-content">${escapeHtml(m.content)}</div>`
        }
        ${isImage && m.content ? `<div class="msg-caption">${escapeHtml(m.content)}</div>` : ''}
      </div>
    `;
  }

  function renderImagePreview() {
    return `
      <div class="image-preview">
        <img src="${pendingImage.preview}" alt="Preview">
        <input type="text" id="caption" class="auth-input" placeholder="Add a caption (optional)" style="margin-top: 0.75rem;">
        <div class="preview-actions">
          <button type="button" id="cancel-image" class="action-btn">Cancel</button>
          <button type="submit" class="send-btn" ${isSending ? 'disabled' : ''}>
            ${isSending ? 'Sending...' : 'Send Image'}
          </button>
        </div>
      </div>
    `;
  }

  function renderWebcam() {
    return `
      <div class="webcam-container">
        <video id="webcam-video" autoplay playsinline></video>
        <canvas id="webcam-canvas" style="display:none;"></canvas>
        <div class="webcam-actions">
          <button type="button" id="capture-btn" class="action-btn">Capture</button>
          <button type="button" id="cancel-webcam" class="action-btn">Cancel</button>
        </div>
      </div>
    `;
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  function attachEventListeners() {
    // Tab switching
    container.querySelectorAll('.auth-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        authMode = tab.dataset.mode;
        render();
      });
    });

    // Auth form submission
    const form = container.querySelector('#auth-form');
    if (form) {
      form.addEventListener('submit', handleAuth);
    }

    // Connect to WS
    const connectBtn = container.querySelector('#connect-ws');
    if (connectBtn) {
      connectBtn.addEventListener('click', handleConnectGateway);
    }

    // Logout
    const logoutBtn = container.querySelector('#logout');
    if (logoutBtn) {
      logoutBtn.addEventListener('click', handleLogout);
    }

    // Send message form
    const sendForm = container.querySelector('#send-form');
    if (sendForm) {
      sendForm.addEventListener('submit', handleSendMessage);
    }

    // Copy user ID
    const copyBtn = container.querySelector('#copy-id');
    if (copyBtn) {
      copyBtn.addEventListener('click', () => {
        const userId = client.getUserId();
        if (userId) {
          navigator.clipboard.writeText(userId);
          copyBtn.textContent = 'Copied!';
          setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1500);
        }
      });
    }

    // Drag and drop for images
    const composeArea = container.querySelector('#compose-area');
    if (composeArea) {
      composeArea.addEventListener('dragover', (e) => {
        e.preventDefault();
        composeArea.classList.add('drag-over');
      });
      composeArea.addEventListener('dragleave', () => {
        composeArea.classList.remove('drag-over');
      });
      composeArea.addEventListener('drop', handleImageDrop);
    }

    // Webcam button
    const webcamBtn = container.querySelector('#webcam-btn');
    if (webcamBtn) {
      webcamBtn.addEventListener('click', startWebcam);
    }

    // Webcam capture
    const captureBtn = container.querySelector('#capture-btn');
    if (captureBtn) {
      captureBtn.addEventListener('click', captureWebcam);
    }

    // Cancel webcam
    const cancelWebcamBtn = container.querySelector('#cancel-webcam');
    if (cancelWebcamBtn) {
      cancelWebcamBtn.addEventListener('click', stopWebcam);
    }

    // Cancel image preview
    const cancelImageBtn = container.querySelector('#cancel-image');
    if (cancelImageBtn) {
      cancelImageBtn.addEventListener('click', () => {
        pendingImage = null;
        render();
      });
    }

    // Start webcam video if active
    if (webcamActive) {
      const video = container.querySelector('#webcam-video');
      if (video && webcamStream) {
        video.srcObject = webcamStream;
      }
    }
  }

  function scrollLogToBottom() {
    const logEl = container.querySelector('.log-content');
    if (logEl) {
      logEl.scrollTop = logEl.scrollHeight;
    }
  }

  async function handleAuth(e) {
    e.preventDefault();
    const formData = new FormData(e.target);
    const username = formData.get('username');
    const password = formData.get('password');

    isLoading = true;
    render();

    try {
      if (authMode === 'register') {
        log('Generating cryptographic keys...', 'info');
        const keys = await generateRegistrationKeys();

        log('Registering with server...', 'info');
        const regResult = await client.register({
          username,
          password,
          identityKey: keys.identityKey,
          registrationId: keys.registrationId,
          signedPreKey: keys.signedPreKey,
          oneTimePreKeys: keys.oneTimePreKeys,
        });
        console.log('=== REGISTER RESPONSE ===', regResult);
        console.log('=== JWT PAYLOAD ===', client.getTokenPayload());

        // Init stores with user ID, then store keys
        const userId = client.getUserId();
        initStoresForUser(userId);
        await storeGeneratedKeys(keys._rawKeys);
        storeKeys(keys);

        log('Registration successful!', 'success');
      } else {
        log('Authenticating...', 'info');
        const loginResult = await client.login(username, password);
        console.log('=== LOGIN RESPONSE ===', loginResult);
        console.log('=== JWT PAYLOAD ===', client.getTokenPayload());

        // Init stores with user ID
        const userId = client.getUserId();
        initStoresForUser(userId);

        log('Login successful!', 'success');
      }
    } catch (error) {
      const detail = error.body ? ` ${JSON.stringify(error.body)}` : '';
      log(`Error: ${error.message}${detail}`, 'error');
    } finally {
      isLoading = false;
      render();
    }
  }

  async function handleConnectGateway() {
    try {
      await gateway.connect();
    } catch (error) {
      log(`Gateway error: ${error.message}`, 'error');
    }
  }

  async function handleLogout() {
    log('Logging out...', 'info');
    gateway.disconnect();
    stopWebcam();
    await client.logout();
    // Keys persist in IndexedDB - user can receive messages sent while logged out
    log('Logged out', 'success');
    render();
  }

  async function handleImageDrop(e) {
    e.preventDefault();
    e.currentTarget.classList.remove('drag-over');

    const file = e.dataTransfer?.files?.[0];
    if (!file || !file.type.startsWith('image/')) {
      log('Please drop an image file', 'error');
      return;
    }

    try {
      const arrayBuffer = await file.arrayBuffer();
      const data = new Uint8Array(arrayBuffer);
      const preview = URL.createObjectURL(file);

      pendingImage = {
        data,
        mimeType: file.type,
        preview,
      };
      render();
    } catch (error) {
      log(`Failed to load image: ${error.message}`, 'error');
    }
  }

  async function startWebcam() {
    try {
      webcamStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } }
      });
      webcamActive = true;
      render();
    } catch (error) {
      log(`Webcam error: ${error.message}`, 'error');
    }
  }

  function stopWebcam() {
    if (webcamStream) {
      webcamStream.getTracks().forEach(track => track.stop());
      webcamStream = null;
    }
    webcamActive = false;
    render();
  }

  function captureWebcam() {
    const video = container.querySelector('#webcam-video');
    const canvas = container.querySelector('#webcam-canvas');
    if (!video || !canvas) return;

    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0);

    canvas.toBlob((blob) => {
      if (blob) {
        blob.arrayBuffer().then(arrayBuffer => {
          pendingImage = {
            data: new Uint8Array(arrayBuffer),
            mimeType: 'image/png',
            preview: canvas.toDataURL('image/png'),
          };
          stopWebcam();
        });
      }
    }, 'image/png');
  }

  async function handleSendMessage(e) {
    e.preventDefault();
    const formData = new FormData(e.target);
    const recipient = formData.get('recipient')?.trim();
    const messageText = formData.get('message')?.trim() || '';
    const caption = container.querySelector('#caption')?.value?.trim() || '';

    if (!recipient) return;
    if (!pendingImage && !messageText) return;

    isSending = true;
    render();

    try {
      await gateway.loadProto();

      let clientMessageBytes;
      let localMessage;

      if (pendingImage) {
        // Send image
        clientMessageBytes = gateway.encodeClientMessage({
          type: 'IMAGE',
          text: caption,
          imageData: pendingImage.data,
          mimeType: pendingImage.mimeType,
        });
        localMessage = {
          direction: 'out',
          to: recipient,
          type: 'IMAGE',
          content: caption,
          imageData: pendingImage.preview,
          time: new Date().toLocaleTimeString('en-US', { hour12: false }),
        };
      } else {
        // Send text
        clientMessageBytes = gateway.encodeClientMessage({
          type: 'TEXT',
          text: messageText,
        });
        localMessage = {
          direction: 'out',
          to: recipient,
          type: 'TEXT',
          content: messageText,
          time: new Date().toLocaleTimeString('en-US', { hour12: false }),
        };
      }

      // Encrypt the message using Signal Protocol
      log(`Encrypting for ${recipient.slice(0, 8)}...`, 'info');
      const encrypted = await sessionManager.encrypt(recipient, clientMessageBytes);

      // Wrap encrypted content in EncryptedMessage proto
      // encrypted.protoType: 1 = PREKEY_MESSAGE, 2 = ENCRYPTED_MESSAGE
      // encrypted.body is already a Uint8Array
      const protobufData = gateway.encodeOutgoingMessage(encrypted.body, encrypted.protoType);

      log(`Sending to ${recipient.slice(0, 8)}...`, 'info');
      await client.sendMessage(recipient, protobufData);

      messages.push(localMessage);
      log('Message sent!', 'success');

      // Clear message/caption but keep recipient
      lastRecipient = recipient;
      pendingImage = null;
      const messageField = e.target.querySelector('#message');
      const captionField = e.target.querySelector('#caption');
      if (messageField) messageField.value = '';
      if (captionField) captionField.value = '';
    } catch (error) {
      log(`Send failed: ${error.message}`, 'error');
      console.error(error);
    } finally {
      isSending = false;
      render();
    }
  }

  // Set up gateway event listeners
  gateway.on('status', ({ state, message }) => {
    const typeMap = {
      connecting: 'info',
      connected: 'success',
      disconnected: '',
      error: 'error',
      reconnecting: 'info',
      failed: 'error',
    };
    log(message, typeMap[state] || '');
  });

  gateway.on('envelope', async (envelope) => {
    log(`Message received from ${envelope.sourceUserId.slice(0, 8)}...`, 'info');

    // Decrypt and decode ClientMessage from content
    let clientMsg = { type: 'TEXT', text: '[could not decode]', imageData: null, mimeType: '' };
    try {
      if (envelope.message && envelope.message.content) {
        // Decrypt using Signal Protocol
        log('Decrypting...', 'info');
        const decryptedBytes = await sessionManager.decrypt(
          envelope.sourceUserId,
          envelope.message.content,
          envelope.message.type  // 1 = PREKEY_MESSAGE, 2 = ENCRYPTED_MESSAGE
        );

        // Decode the decrypted ClientMessage
        clientMsg = gateway.decodeClientMessage(new Uint8Array(decryptedBytes));
        log('Decryption successful', 'success');
      }
    } catch (e) {
      console.warn('Could not decrypt/decode message:', e);
      log(`Decryption failed: ${e.message}`, 'error');
    }

    // Convert image bytes to data URL for display
    let imageDataUrl = null;
    if (clientMsg.type === 'IMAGE' && clientMsg.imageData && clientMsg.imageData.length > 0) {
      const base64 = uint8ArrayToBase64(clientMsg.imageData);
      imageDataUrl = `data:${clientMsg.mimeType || 'image/png'};base64,${base64}`;
    }

    messages.push({
      direction: 'in',
      from: envelope.sourceUserId,
      type: clientMsg.type,
      content: clientMsg.text,
      imageData: imageDataUrl,
      time: new Date(Number(envelope.timestamp)).toLocaleTimeString('en-US', { hour12: false }),
    });
    render();
  });

  gateway.on('ack', ({ messageId }) => {
    log(`Acknowledged: ${messageId.slice(0, 8)}...`, 'success');
  });

  // Initial render
  log('Obscura client initialized', 'info');
  log(`Endpoint: ${import.meta.env.VITE_API_URL}`, '');

  // Try to load existing session
  if (client.loadTokens()) {
    // Init stores with user ID from restored session
    const userId = client.getUserId();
    if (userId) {
      initStoresForUser(userId);
    }
    log('Session restored from storage', 'success');
  }

  render();
}
