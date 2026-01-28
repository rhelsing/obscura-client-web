/**
 * Login View
 * - Username + password inputs
 * - Handle: ok (existing device), newDevice, error
 */
import { Obscura } from '../../lib/index.js';
import { setClient, navigate } from '../index.js';

let cleanup = null;

export function render({ error = null, loading = false } = {}) {
  return `
    <div class="view login">
      <h1>Login</h1>
      ${error ? `<div class="error">${error}</div>` : ''}
      <form id="login-form">
        <input type="text" id="username" placeholder="Username" required autocomplete="username" ${loading ? 'disabled' : ''} />
        <input type="password" id="password" placeholder="Password" required autocomplete="current-password" ${loading ? 'disabled' : ''} />
        <button type="submit" ${loading ? 'disabled' : ''}>${loading ? 'Logging in...' : 'Login'}</button>
      </form>
      <p class="link">Don't have an account? <a href="/register" data-navigo>Register</a></p>
    </div>
  `;
}

export function mount(container, client, router) {
  container.innerHTML = render();

  const form = container.querySelector('#login-form');

  const handleSubmit = async (e) => {
    e.preventDefault();

    const username = container.querySelector('#username').value.trim();
    const password = container.querySelector('#password').value;

    container.innerHTML = render({ loading: true });

    try {
      const apiUrl = import.meta.env.VITE_API_URL;

      // Try to get existing store from localStorage
      const storeKey = `obscura_store_${username}`;
      let existingStore = null;
      try {
        const stored = localStorage.getItem(storeKey);
        if (stored) {
          existingStore = JSON.parse(stored);
        }
      } catch (e) {
        // No existing store
      }

      const result = await Obscura.login(username, password, {
        apiUrl,
        store: existingStore
      });

      if (result.status === 'ok') {
        // Existing device, go to main app
        setClient(result.client || client);
        await (result.client || client).connect();
        navigate('/stories');

      } else if (result.status === 'newDevice') {
        // New device needs approval
        // Store client temporarily for LinkPending view
        window.__pendingClient = result.client;
        navigate('/link-pending');

      } else {
        // Error
        container.innerHTML = render({ error: result.reason || 'Login failed' });
        mount(container, client, router);
      }

    } catch (err) {
      container.innerHTML = render({ error: err.message });
      mount(container, client, router);
    }
  };

  form.addEventListener('submit', handleSubmit);
  router.updatePageLinks();

  cleanup = () => {
    form.removeEventListener('submit', handleSubmit);
  };
}

export function unmount() {
  if (cleanup) {
    cleanup();
    cleanup = null;
  }
}
