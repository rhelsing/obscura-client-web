/**
 * RevokeDevice View
 * - Confirm revocation
 * - Enter recovery phrase
 * - Call revokeDevice
 */
import { navigate } from '../index.js';

let cleanup = null;

export function render({ deviceId = '', error = null, loading = false, success = false } = {}) {
  if (success) {
    return `
      <div class="view revoke-device">
        <h1>Device Revoked</h1>
        <div class="success">
          <p>The device has been revoked and can no longer access your account.</p>
        </div>
        <button id="done-btn">Done</button>
      </div>
    `;
  }

  return `
    <div class="view revoke-device">
      <header>
        <a href="/devices" data-navigo class="back">← Cancel</a>
        <h1>Revoke Device</h1>
      </header>

      <div class="warning">
        <p>You are about to revoke device:</p>
        <code>${deviceId.slice(0, 8)}...</code>
        <p>This device will no longer be able to access your account.</p>
      </div>

      ${error ? `<div class="error">${error}</div>` : ''}

      <form id="revoke-form">
        <label>
          Recovery Phrase
          <textarea
            id="recovery-phrase"
            rows="3"
            placeholder="Enter your 12-word recovery phrase"
            required
            ${loading ? 'disabled' : ''}
          ></textarea>
        </label>

        <button type="submit" class="danger" ${loading ? 'disabled' : ''}>
          ${loading ? 'Revoking...' : 'Revoke Device'}
        </button>
      </form>
    </div>
  `;
}

export function mount(container, client, router, params) {
  const deviceId = params.deviceId;

  container.innerHTML = render({ deviceId });

  const form = container.querySelector('#revoke-form');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();

    const phrase = container.querySelector('#recovery-phrase').value.trim();

    if (!phrase) {
      container.innerHTML = render({ deviceId, error: 'Please enter your recovery phrase' });
      mount(container, client, router, params);
      return;
    }

    // Validate phrase format (12 words)
    const words = phrase.split(/\s+/);
    if (words.length !== 12) {
      container.innerHTML = render({ deviceId, error: 'Recovery phrase must be 12 words' });
      mount(container, client, router, params);
      return;
    }

    container.innerHTML = render({ deviceId, loading: true });

    try {
      await client.revokeDevice(phrase, deviceId);

      container.innerHTML = render({ deviceId, success: true });

      const doneBtn = container.querySelector('#done-btn');
      doneBtn.addEventListener('click', () => {
        navigate('/devices');
      });

    } catch (err) {
      container.innerHTML = render({ deviceId, error: err.message });
      mount(container, client, router, params);
    }
  });

  router.updatePageLinks();

  cleanup = () => {};
}

export function unmount() {
  if (cleanup) {
    cleanup();
    cleanup = null;
  }
}
