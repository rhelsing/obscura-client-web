// Mobile auth screen (login/register)
import client from '../api/client.js';
import { generateRegistrationKeys, storeKeys } from '../lib/crypto.js';

const LOADING_MESSAGES = [
  'Conbobulating...',
  'Encrypting the things...',
  'Generating entropy...',
  'Warming up the flux capacitor...',
  'Untangling quantum states...',
  'Calibrating photon torpedoes...',
  'Reversing the polarity...',
  'Summoning secure electrons...',
  'Shuffling the bits...',
  'Consulting the oracle...',
  'Initializing crypto magic...',
  'Handshaking vigorously...',
  'Establishing plausible deniability...',
  'Scrambling the scrambler...',
];

export function renderAuth(container, onSuccess) {
  let mode = 'login'; // 'login' or 'register'
  let isLoading = false;
  let error = null;
  let loadingMessageIndex = 0;
  let loadingInterval = null;

  function render() {
    if (isLoading) {
      renderLoading();
      return;
    }

    container.innerHTML = `
      <div class="auth-screen">
        <div class="auth-logo">obscura</div>

        ${error ? `<div class="auth-error">${error}</div>` : ''}

        <form class="auth-form" id="auth-form">
          <input
            type="text"
            class="auth-input"
            id="username"
            name="username"
            placeholder="Username"
            autocomplete="username"
            autocapitalize="none"
            required
          >
          <input
            type="password"
            class="auth-input"
            id="password"
            name="password"
            placeholder="Password"
            autocomplete="${mode === 'login' ? 'current-password' : 'new-password'}"
            required
          >
          <button type="submit" class="auth-btn">
            ${mode === 'login' ? 'Sign In' : 'Create Account'}
          </button>
        </form>

        <div class="auth-toggle">
          ${mode === 'login' ? "Don't have an account?" : 'Already have an account?'}
          <button id="toggle-mode">
            ${mode === 'login' ? 'Sign Up' : 'Sign In'}
          </button>
        </div>
      </div>
    `;

    attachListeners();
  }

  function renderLoading() {
    container.innerHTML = `
      <div class="loading-screen">
        <div class="boxes">
          <div class="box">
            <div></div>
            <div></div>
            <div></div>
            <div></div>
          </div>
          <div class="box">
            <div></div>
            <div></div>
            <div></div>
            <div></div>
          </div>
          <div class="box">
            <div></div>
            <div></div>
            <div></div>
            <div></div>
          </div>
          <div class="box">
            <div></div>
            <div></div>
            <div></div>
            <div></div>
          </div>
        </div>
        <div class="loading-text" id="loading-text">${LOADING_MESSAGES[Math.floor(Math.random() * LOADING_MESSAGES.length)]}</div>
      </div>
    `;

    // Cycle through messages
    loadingMessageIndex = Math.floor(Math.random() * LOADING_MESSAGES.length);
    if (loadingInterval) clearInterval(loadingInterval);
    loadingInterval = setInterval(() => {
      loadingMessageIndex = Math.floor(Math.random() * LOADING_MESSAGES.length);
      const textEl = container.querySelector('#loading-text');
      if (textEl) {
        textEl.textContent = LOADING_MESSAGES[loadingMessageIndex];
      }
    }, 1500);
  }

  function stopLoading() {
    if (loadingInterval) {
      clearInterval(loadingInterval);
      loadingInterval = null;
    }
  }

  function attachListeners() {
    const form = container.querySelector('#auth-form');
    const toggleBtn = container.querySelector('#toggle-mode');

    form.addEventListener('submit', handleSubmit);
    toggleBtn.addEventListener('click', () => {
      mode = mode === 'login' ? 'register' : 'login';
      error = null;
      render();
    });
  }

  async function handleSubmit(e) {
    e.preventDefault();
    const formData = new FormData(e.target);
    const username = formData.get('username').trim();
    const password = formData.get('password');

    if (!username || !password) {
      error = 'Please enter username and password';
      render();
      return;
    }

    isLoading = true;
    error = null;
    render();

    try {
      if (mode === 'register') {
        // Generate Signal Protocol keys
        const keys = await generateRegistrationKeys();
        storeKeys(keys);

        // Register with server
        await client.register({
          username,
          password,
          identityKey: keys.identityKey,
          registrationId: keys.registrationId,
          signedPreKey: keys.signedPreKey,
          oneTimePreKeys: keys.oneTimePreKeys,
        });

        // Store username locally
        localStorage.setItem('obscura_username', username);
      } else {
        // Login
        await client.login(username, password);
        localStorage.setItem('obscura_username', username);

        // Check if we have Signal keys locally - if not, regenerate
        const { hasSignalKeys } = await import('../lib/crypto.js');
        if (!(await hasSignalKeys())) {
          console.log('No local keys found, regenerating...');
          const keys = await generateRegistrationKeys();
          storeKeys(keys);
          // Upload new keys to server
          await client.uploadKeys({
            identityKey: keys.identityKey,
            registrationId: keys.registrationId,
            signedPreKey: keys.signedPreKey,
            oneTimePreKeys: keys.oneTimePreKeys,
          });
        }
      }

      // Success - cleanup and callback to parent
      stopLoading();
      onSuccess();
    } catch (err) {
      console.error('Auth error:', err);
      if (err.status === 401) {
        error = 'Invalid username or password';
      } else if (err.status === 409) {
        error = 'Username already taken';
      } else if (err.body?.message) {
        error = err.body.message;
      } else {
        error = err.message || 'Something went wrong';
      }
      stopLoading();
      isLoading = false;
      render();
    }
  }

  // Initial render
  render();
}
