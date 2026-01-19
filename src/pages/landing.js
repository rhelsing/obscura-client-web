import client from '../api/client.js';
import gateway from '../api/gateway.js';
import { generateRegistrationKeys, storeKeys, clearKeys } from '../lib/crypto.js';
import { sessionManager } from '../lib/sessionManager.js';

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

    container.innerHTML = `
      <h1>obscura</h1>
      <h2>privacy-first messaging relay</h2>

      <div class="card">
        <div class="card-header">
          <div class="status-indicator ${wsConnected ? 'connected' : isAuth ? 'connecting' : ''}"></div>
          <span class="card-title">Connection Status</span>
        </div>
        <div class="log" id="log">
          ${logs.length === 0 ? '<div class="log-entry"><span class="log-message">Ready to connect...</span></div>' : ''}
          ${logs.map(l => `
            <div class="log-entry">
              <span class="log-time">${l.time}</span>
              <span class="log-message ${l.type}">${l.message}</span>
            </div>
          `).join('')}
        </div>
      </div>

      ${isAuth ? renderAuthenticatedUI(wsConnected) : renderAuthForm()}
    `;

    attachEventListeners();
    scrollLogToBottom();
  }

  function renderAuthForm() {
    return `
      <div class="card">
        <div class="tabs">
          <button class="tab ${authMode === 'login' ? 'active' : ''}" data-mode="login">Login</button>
          <button class="tab ${authMode === 'register' ? 'active' : ''}" data-mode="register">Register</button>
        </div>

        <form id="auth-form">
          <div class="form-group">
            <label for="username">Username</label>
            <input type="text" id="username" name="username" required autocomplete="username">
          </div>
          <div class="form-group">
            <label for="password">Password</label>
            <input type="password" id="password" name="password" required autocomplete="current-password">
          </div>
          <button type="submit" ${isLoading ? 'disabled' : ''}>
            ${isLoading ? 'Please wait...' : authMode === 'login' ? 'Connect' : 'Create Account'}
          </button>
        </form>
      </div>
    `;
  }

  function renderAuthenticatedUI(wsConnected) {
    const userId = client.getUserId();
    const payload = client.getTokenPayload();

    return `
      <div class="card">
        <div class="card-header">
          <span class="card-title">Session</span>
        </div>
        <div class="user-info-block">
          <div class="user-id-row">
            <label>Your User ID</label>
            <code class="user-id-value" id="user-id">${userId || 'Unknown'}</code>
            <button class="copy-btn" id="copy-id" title="Copy to clipboard">Copy</button>
          </div>
          <div class="user-meta">
            Token expires: ${new Date(client.expiresAt * 1000).toLocaleTimeString()}
            ${payload ? ` | JWT: ${JSON.stringify(payload)}` : ''}
          </div>
        </div>
        <button id="connect-ws" class="secondary" ${wsConnected ? 'disabled' : ''}>
          ${wsConnected ? 'Gateway Connected' : 'Connect to Gateway'}
        </button>
        <button id="logout" class="secondary mt-1">
          Logout
        </button>
      </div>

      ${wsConnected ? renderMessaging() : ''}
    `;
  }

  function renderMessaging() {
    return `
      <div class="card">
        <div class="card-header">
          <span class="card-title">Messages</span>
        </div>

        <div class="messages-list" id="messages-list">
          ${messages.length === 0
            ? '<div class="no-messages">No messages yet</div>'
            : messages.map(m => renderMessage(m)).join('')
          }
        </div>

        <form id="send-form" class="mt-2">
          <div class="form-group">
            <label for="recipient">Recipient User ID</label>
            <input type="text" id="recipient" name="recipient" placeholder="UUID of recipient" value="${lastRecipient}" required>
          </div>

          <div class="compose-area" id="compose-area">
            ${webcamActive ? renderWebcam() : ''}
            ${pendingImage ? renderImagePreview() : ''}
            ${!webcamActive && !pendingImage ? `
              <div class="form-group">
                <label for="message">Message</label>
                <textarea id="message" name="message" rows="3" placeholder="Type your message or drop an image..."></textarea>
              </div>
              <div class="compose-actions">
                <button type="button" id="webcam-btn" class="secondary icon-btn" title="Take photo">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/>
                    <circle cx="12" cy="13" r="4"/>
                  </svg>
                </button>
                <button type="submit" ${isSending ? 'disabled' : ''}>
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
      <div class="message ${m.direction}">
        <div class="message-meta">
          <span class="message-user">${m.direction === 'in' ? m.from.slice(0, 8) + '...' : 'You → ' + m.to.slice(0, 8) + '...'}</span>
          <span class="message-time">${m.time}</span>
        </div>
        ${isImage
          ? `<img class="message-image" src="${m.imageData}" alt="Image">`
          : `<div class="message-content">${escapeHtml(m.content)}</div>`
        }
        ${isImage && m.content ? `<div class="message-caption">${escapeHtml(m.content)}</div>` : ''}
      </div>
    `;
  }

  function renderImagePreview() {
    return `
      <div class="image-preview">
        <img src="${pendingImage.preview}" alt="Preview">
        <div class="form-group mt-1">
          <input type="text" id="caption" placeholder="Add a caption (optional)">
        </div>
        <div class="preview-actions">
          <button type="button" id="cancel-image" class="secondary">Cancel</button>
          <button type="submit" ${isSending ? 'disabled' : ''}>
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
          <button type="button" id="capture-btn" class="secondary">Capture</button>
          <button type="button" id="cancel-webcam" class="secondary">Cancel</button>
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
    container.querySelectorAll('.tab').forEach(tab => {
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
    const logEl = container.querySelector('#log');
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
        storeKeys(keys);

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
        log('Registration successful!', 'success');
      } else {
        log('Authenticating...', 'info');
        const loginResult = await client.login(username, password);
        console.log('=== LOGIN RESPONSE ===', loginResult);
        console.log('=== JWT PAYLOAD ===', client.getTokenPayload());
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
    clearKeys();
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
      const base64 = btoa(String.fromCharCode(...clientMsg.imageData));
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
    log('Session restored from storage', 'success');
  }

  render();
}
