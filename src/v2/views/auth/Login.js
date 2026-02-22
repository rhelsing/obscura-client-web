/**
 * Login View
 * - Username + password inputs
 * - Handle: ok (existing device), newDevice, error
 */
import { Obscura, ObscuraClient } from '../../lib/index.js';
import { setClient, navigate, getApiUrl } from '../index.js';
import { fullSchema } from '../../lib/schema.js';
import { logger } from '../../lib/logger.js';

let cleanup = null;

export function render({ loading = false } = {}) {
  return `
    <div class="view login">
      <h1>Login</h1>
      <form id="login-form">
        <stack gap="md">
          <ry-field label="Username">
            <input type="text" id="username" placeholder="Enter username" required autocomplete="username" ${loading ? 'disabled' : ''} />
          </ry-field>
          <ry-field label="Password">
            <input type="password" id="password" placeholder="Enter password" required autocomplete="current-password" ${loading ? 'disabled' : ''} />
          </ry-field>
          <button type="submit" ${loading ? 'disabled' : ''}>${loading ? 'Logging in...' : 'Login'}</button>
        </stack>
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
      const apiUrl = getApiUrl();

      // Clear any stale session before login to prevent old user's session competing
      ObscuraClient.clearSession();

      // Note: Obscura.login() automatically uses IndexedDBStore which persists to IndexedDB.
      // It checks store.getDeviceIdentity() to detect if this is an existing device.
      const result = await Obscura.login(username, password, { apiUrl });

      if (result.status === 'ok') {
        // Existing device, go to main app
        const c = result.client || client;
        await c.schema(fullSchema);
        await c.connect();
        setClient(c);
        logger.logLogin({ username, result: 'ok', isNewDevice: false,
          hasShellToken: !!c.shellToken, hasShellRefreshToken: !!c.shellRefreshToken,
          hasDeviceIdentity: true });
        navigate('/stories');

      } else if (result.status === 'newDevice') {
        // New device needs approval
        // Store client temporarily for LinkPending view
        window.__pendingClient = result.client;
        logger.logLogin({ username, result: 'newDevice', isNewDevice: true,
          hasShellToken: !!result.client.shellToken, hasShellRefreshToken: !!result.client.shellRefreshToken,
          hasDeviceIdentity: false });
        navigate('/link-pending');

      } else {
        // Error
        logger.logLoginError({ username, reason: result.reason || 'Login failed', stage: 'auth' });
        RyToast.error(result.reason || 'Login failed');
        container.innerHTML = render();
      }

    } catch (err) {
      logger.logLoginError({ username, reason: err.message || 'Login failed', stage: 'unknown' });
      RyToast.error(err.message || 'Login failed');
      container.innerHTML = render();
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
