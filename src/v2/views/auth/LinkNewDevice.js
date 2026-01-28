/**
 * LinkNewDevice View
 * - Existing device approving a new device
 * - Input for linkCode (or QR scanner)
 * - Calls approveLink + announceDevices
 */
import { navigate } from '../index.js';

let cleanup = null;

export function render({ error = null, success = false, loading = false } = {}) {
  if (success) {
    return `
      <div class="view link-new-device">
        <h1>Device Linked!</h1>
        <div class="success">
          <p>The new device has been linked to your account.</p>
        </div>
        <button id="done-btn">Done</button>
      </div>
    `;
  }

  return `
    <div class="view link-new-device">
      <h1>Link New Device</h1>
      <p>Enter the code shown on your new device, or scan the QR code.</p>

      ${error ? `<div class="error">${error}</div>` : ''}

      <form id="link-form">
        <input
          type="text"
          id="link-code"
          placeholder="Enter link code"
          required
          autocomplete="off"
          ${loading ? 'disabled' : ''}
        />
        <button type="submit" ${loading ? 'disabled' : ''}>
          ${loading ? 'Linking...' : 'Approve Link'}
        </button>
      </form>

      <div class="qr-scanner-section">
        <button id="scan-qr-btn" class="secondary" ${loading ? 'disabled' : ''}>
          Scan QR Code
        </button>
      </div>

      <p class="link"><a href="/devices" data-navigo>Cancel</a></p>
    </div>
  `;
}

export function mount(container, client, router) {
  container.innerHTML = render();

  const form = container.querySelector('#link-form');

  const handleSubmit = async (e) => {
    e.preventDefault();

    const linkCode = container.querySelector('#link-code').value.trim();

    if (!linkCode) {
      container.innerHTML = render({ error: 'Please enter a link code' });
      mount(container, client, router);
      return;
    }

    container.innerHTML = render({ loading: true });

    try {
      await client.approveLink(linkCode);
      await client.announceDevices();

      container.innerHTML = render({ success: true });

      const doneBtn = container.querySelector('#done-btn');
      doneBtn.addEventListener('click', () => {
        navigate('/devices');
      });

    } catch (err) {
      container.innerHTML = render({ error: err.message });
      mount(container, client, router);
    }
  };

  form.addEventListener('submit', handleSubmit);

  // QR scanner placeholder
  const scanBtn = container.querySelector('#scan-qr-btn');
  scanBtn.addEventListener('click', () => {
    alert('QR scanning not yet implemented');
  });

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
