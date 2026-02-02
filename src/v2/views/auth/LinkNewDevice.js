/**
 * LinkNewDevice View
 * - Existing device approving a new device
 * - Input for linkCode or scan QR
 * - Calls approveLink + announceDevices
 */
import { navigate } from '../index.js';
import { Html5Qrcode } from 'html5-qrcode';

let cleanup = null;
let qrScanner = null;

export function render({ error = null, success = false, loading = false, scanning = false } = {}) {
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
      <p>Scan the QR code on your new device, or enter the code manually.</p>

      ${error ? `<div class="error">${error}</div>` : ''}

      <div id="scanner-container" style="display: ${scanning ? 'block' : 'none'}; margin-bottom: 1rem;">
        <div id="qr-reader" style="width: 100%;"></div>
        <button variant="secondary" id="stop-scan-btn" style="margin-top: 0.5rem; width: 100%;">Cancel Scan</button>
      </div>

      <form id="link-form" style="display: ${scanning ? 'none' : 'block'};">
        <stack gap="md">
          <button type="button" id="scan-btn" variant="secondary" ${loading ? 'disabled' : ''} style="width: 100%;">
            <ry-icon name="camera"></ry-icon> Scan QR Code
          </button>
          <ry-field label="Or enter code manually">
            <input
              type="text"
              id="link-code"
              placeholder="Enter link code"
              autocomplete="off"
              ${loading ? 'disabled' : ''}
              style="font-family: monospace;"
            />
          </ry-field>
          <button type="submit" ${loading ? 'disabled' : ''}>
            ${loading ? 'Linking...' : 'Approve Link'}
          </button>
        </stack>
      </form>

      <p class="link"><a href="/devices" data-navigo>Cancel</a></p>
    </div>
  `;
}

export function mount(container, client, router, params = {}) {
  const error = typeof params === 'string' ? params : params?.error || null;

  container.innerHTML = render({ error });

  const form = container.querySelector('#link-form');
  const scanBtn = container.querySelector('#scan-btn');

  // Handle link approval (shared by form submit and QR scan)
  const handleApprove = async (linkCode) => {
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
      mount(container, client, router, err.message);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();

    const linkCode = container.querySelector('#link-code').value.trim();

    if (!linkCode) {
      mount(container, client, router, 'Please enter a link code');
      return;
    }

    await handleApprove(linkCode);
  };

  // Start QR scanner
  const startScanner = async () => {
    container.innerHTML = render({ scanning: true });

    const stopBtn = container.querySelector('#stop-scan-btn');
    stopBtn.addEventListener('click', () => stopScanner());

    try {
      qrScanner = new Html5Qrcode('qr-reader');
      await qrScanner.start(
        { facingMode: 'environment' },
        { fps: 10, qrbox: { width: 250, height: 250 } },
        async (decodedText) => {
          await stopScanner();
          await handleApprove(decodedText.trim());
        },
        () => {} // ignore errors during scanning
      );
    } catch (err) {
      await stopScanner();
      mount(container, client, router, 'Could not access camera');
    }
  };

  const stopScanner = async () => {
    if (qrScanner) {
      try {
        await qrScanner.stop();
      } catch {
        // ignore
      }
      qrScanner = null;
    }
    mount(container, client, router, params);
  };

  form.addEventListener('submit', handleSubmit);
  scanBtn.addEventListener('click', startScanner);

  router.updatePageLinks();

  cleanup = () => {
    form.removeEventListener('submit', handleSubmit);
    if (qrScanner) {
      qrScanner.stop().catch(() => {});
      qrScanner = null;
    }
  };
}

export function unmount() {
  if (cleanup) {
    cleanup();
    cleanup = null;
  }
}
