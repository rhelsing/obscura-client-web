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
        <label>Recovery Phrase</label>
        <div class="phrase-grid">
          ${[1,2,3,4,5,6,7,8,9,10,11,12].map(i => `
            <div class="phrase-input-wrapper">
              <span class="phrase-number">${i}</span>
              <input
                type="text"
                class="phrase-word"
                data-index="${i}"
                autocomplete="off"
                autocapitalize="none"
                ${loading ? 'disabled' : ''}
              />
            </div>
          `).join('')}
        </div>

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
  const inputs = container.querySelectorAll('.phrase-word');

  // Handle paste of full phrase into any input
  inputs.forEach((input, idx) => {
    input.addEventListener('paste', (e) => {
      const pasted = e.clipboardData.getData('text').trim();
      const words = pasted.split(/\s+/);
      if (words.length > 1) {
        e.preventDefault();
        // Distribute words across inputs starting from current
        words.forEach((word, i) => {
          if (inputs[idx + i]) {
            inputs[idx + i].value = word.toLowerCase();
          }
        });
        // Focus last filled or next empty
        const lastIdx = Math.min(idx + words.length - 1, 11);
        inputs[lastIdx].focus();
      }
    });

    // Auto-advance on space or after word entry
    input.addEventListener('keydown', (e) => {
      if (e.key === ' ' || e.key === 'Tab') {
        if (e.key === ' ') e.preventDefault();
        if (idx < 11 && input.value.trim()) {
          inputs[idx + 1].focus();
        }
      } else if (e.key === 'Backspace' && !input.value && idx > 0) {
        inputs[idx - 1].focus();
      }
    });

    // Clean input on change
    input.addEventListener('input', () => {
      input.value = input.value.toLowerCase().replace(/[^a-z]/g, '');
    });
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();

    // Collect words from all 12 inputs
    const words = Array.from(inputs).map(i => i.value.trim().toLowerCase());
    const filledWords = words.filter(w => w);

    if (filledWords.length !== 12) {
      container.innerHTML = render({ deviceId, error: 'Please enter all 12 words' });
      mount(container, client, router, params);
      return;
    }

    const phrase = words.join(' ');

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
