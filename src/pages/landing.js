import client from '../api/client.js';
import gateway from '../api/gateway.js';
import { generateRegistrationKeys, storeKeys, clearKeys } from '../lib/crypto.js';

export function renderLanding(container, router) {
  const logs = [];
  const messages = []; // Store received messages
  let authMode = 'login';
  let isLoading = false;
  let isSending = false;

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
            : messages.map(m => `
                <div class="message ${m.direction}">
                  <div class="message-meta">
                    <span class="message-user">${m.direction === 'in' ? m.from.slice(0, 8) + '...' : 'You → ' + m.to.slice(0, 8) + '...'}</span>
                    <span class="message-time">${m.time}</span>
                  </div>
                  <div class="message-content">${escapeHtml(m.content)}</div>
                </div>
              `).join('')
          }
        </div>

        <form id="send-form" class="mt-2">
          <div class="form-group">
            <label for="recipient">Recipient User ID</label>
            <input type="text" id="recipient" name="recipient" placeholder="UUID of recipient" required>
          </div>
          <div class="form-group">
            <label for="message">Message</label>
            <textarea id="message" name="message" rows="3" placeholder="Type your message..." required></textarea>
          </div>
          <button type="submit" ${isSending ? 'disabled' : ''}>
            ${isSending ? 'Sending...' : 'Send Message'}
          </button>
        </form>
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
      log(`Error: ${error.message}`, 'error');
      console.error(error);
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
    await client.logout();
    clearKeys();
    log('Logged out', 'success');
    render();
  }

  async function handleSendMessage(e) {
    e.preventDefault();
    const formData = new FormData(e.target);
    const recipient = formData.get('recipient').trim();
    const messageText = formData.get('message').trim();

    if (!recipient || !messageText) return;

    isSending = true;
    render();

    try {
      // Make sure proto is loaded
      await gateway.loadProto();

      // Encode the message as protobuf
      const protobufData = gateway.encodeOutgoingMessage(messageText);

      log(`Sending to ${recipient.slice(0, 8)}...`, 'info');
      await client.sendMessage(recipient, protobufData);

      // Add to local messages
      messages.push({
        direction: 'out',
        to: recipient,
        content: messageText,
        time: new Date().toLocaleTimeString('en-US', { hour12: false }),
      });

      log('Message sent!', 'success');

      // Clear form
      e.target.reset();
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

  gateway.on('envelope', (envelope) => {
    log(`Message received from ${envelope.sourceUserId.slice(0, 8)}...`, 'info');

    // Decode message content (POC: treat as plaintext)
    let content = '[encrypted]';
    try {
      if (envelope.message && envelope.message.content) {
        content = new TextDecoder().decode(envelope.message.content);
      }
    } catch (e) {
      console.warn('Could not decode message content:', e);
    }

    messages.push({
      direction: 'in',
      from: envelope.sourceUserId,
      content: content,
      time: new Date(Number(envelope.timestamp)).toLocaleTimeString('en-US', { hour12: false }),
      type: envelope.message?.type,
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
