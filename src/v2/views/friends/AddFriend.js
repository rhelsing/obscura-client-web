/**
 * AddFriend View
 * - Show "My Code" with QR code
 * - Input to paste friend's code or scan QR
 * - Parse → befriend
 */
import { navigate } from '../index.js';
import QRCode from 'qrcode';
import { Html5Qrcode } from 'html5-qrcode';

let cleanup = null;
let qrScanner = null;

/**
 * Encode userId + username into a shareable code
 */
function encodeShareCode(userId, username) {
  const data = JSON.stringify({ u: userId, n: username });
  return btoa(data);
}

/**
 * Decode a share code back to userId + username
 */
function decodeShareCode(code) {
  try {
    const data = JSON.parse(atob(code));
    if (!data.u || !data.n) throw new Error('Invalid code');
    return { userId: data.u, username: data.n };
  } catch {
    throw new Error('Invalid friend code');
  }
}

export function render({ myCode = '', error = null, success = false, loading = false, scanning = false } = {}) {
  if (success) {
    return `
      <div class="view add-friend">
        <h1>Friend Request Sent!</h1>
        <ry-alert type="success">
          <p>Waiting for them to accept...</p>
        </ry-alert>
        <button id="done-btn">Done</button>
      </div>
    `;
  }

  return `
    <div class="view add-friend">
      <h1>Add Friend</h1>

      <stack gap="lg">
        <card>
          <h2>Your Code</h2>
          <stack gap="md" style="align-items: center;">
            <div id="qr-code" style="background: white; padding: 1rem; border-radius: 8px;"></div>
            <cluster>
              <input type="text" readonly value="${myCode}" id="my-link-input" style="flex: 1; font-family: monospace; font-size: 0.85rem;" />
              <button variant="secondary" id="copy-btn"><ry-icon name="copy"></ry-icon></button>
            </cluster>
          </stack>
        </card>

        <card>
          <h2>Add Someone</h2>
          ${error ? `<ry-alert type="danger">${error}</ry-alert>` : ''}

          <div id="scanner-container" style="display: ${scanning ? 'block' : 'none'}; margin-bottom: 1rem;">
            <div id="qr-reader" style="width: 100%;"></div>
            <button variant="secondary" id="stop-scan-btn" style="margin-top: 0.5rem;">Cancel Scan</button>
          </div>

          <form id="add-form" style="display: ${scanning ? 'none' : 'block'};">
            <stack gap="md">
              <ry-field label="Friend's Code">
                <input
                  type="text"
                  id="friend-link"
                  placeholder="Paste friend's code"
                  required
                  ${loading ? 'disabled' : ''}
                  style="font-family: monospace;"
                />
              </ry-field>
              <cluster>
                <button type="submit" ${loading ? 'disabled' : ''} style="flex: 1;">
                  ${loading ? 'Sending...' : 'Send Request'}
                </button>
                <button type="button" variant="secondary" id="scan-btn" ${loading ? 'disabled' : ''}>
                  <ry-icon name="camera"></ry-icon> Scan
                </button>
              </cluster>
            </stack>
          </form>
        </card>
      </stack>

      <p class="link"><a href="/friends" data-navigo><ry-icon name="chevron-left"></ry-icon> Back to Friends</a></p>
    </div>
  `;
}

/**
 * Parse friend code or legacy link format
 */
function parseInput(input) {
  const trimmed = input.trim();

  // Try legacy obscura:// link format first
  if (trimmed.startsWith('obscura://') || trimmed.includes('userId=')) {
    try {
      const url = new URL(trimmed.replace('obscura://', 'https://obscura.app/'));
      const userId = url.searchParams.get('userId');
      const username = url.searchParams.get('username');
      if (userId && username) {
        return { userId, username };
      }
    } catch {
      // Fall through to try as code
    }
  }

  // Try as encoded share code
  return decodeShareCode(trimmed);
}

export function mount(container, client, router, params = {}) {
  const error = typeof params === 'string' ? params : params?.error || null;

  // Generate my code
  const myCode = encodeShareCode(client.userId, client.username);

  container.innerHTML = render({ myCode, error });

  // Generate QR code
  const qrContainer = container.querySelector('#qr-code');
  QRCode.toCanvas(myCode, { width: 200, margin: 1 }, (err, canvas) => {
    if (!err && qrContainer) {
      qrContainer.appendChild(canvas);
    }
  });

  const form = container.querySelector('#add-form');
  const copyBtn = container.querySelector('#copy-btn');
  const scanBtn = container.querySelector('#scan-btn');

  // Copy code handler
  copyBtn.addEventListener('click', async () => {
    const input = container.querySelector('#my-link-input');
    try {
      await navigator.clipboard.writeText(input.value);
      copyBtn.innerHTML = '<ry-icon name="check"></ry-icon>';
      setTimeout(() => {
        copyBtn.innerHTML = '<ry-icon name="copy"></ry-icon>';
      }, 2000);
    } catch (e) {
      input.select();
    }
  });

  // Start QR scanner
  const startScanner = async () => {
    container.innerHTML = render({ myCode, scanning: true });

    // Re-generate QR code after re-render
    const qrContainer2 = container.querySelector('#qr-code');
    QRCode.toCanvas(myCode, { width: 200, margin: 1 }, (err, canvas) => {
      if (!err && qrContainer2) {
        qrContainer2.appendChild(canvas);
      }
    });

    const stopBtn = container.querySelector('#stop-scan-btn');
    stopBtn.addEventListener('click', () => stopScanner());

    try {
      qrScanner = new Html5Qrcode('qr-reader');
      await qrScanner.start(
        { facingMode: 'environment' },
        { fps: 10, qrbox: { width: 250, height: 250 } },
        async (decodedText) => {
          await stopScanner();
          await handleAddFriend(decodedText);
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

  scanBtn.addEventListener('click', startScanner);

  // Submit handler
  const handleAddFriend = async (input) => {
    try {
      const { userId, username } = parseInput(input);

      // Reject self-friending
      if (username === client.username) {
        throw new Error("You can't add yourself as a friend");
      }

      container.innerHTML = render({ myCode, loading: true });

      await client.befriend(userId, username);

      container.innerHTML = render({ myCode, success: true });

      const doneBtn = container.querySelector('#done-btn');
      doneBtn.addEventListener('click', () => {
        navigate('/friends');
      });

    } catch (err) {
      const message = typeof err === 'string' ? err
        : err?.message && typeof err.message === 'string' ? err.message
        : 'Something went wrong';
      mount(container, client, router, message);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    const friendCode = container.querySelector('#friend-link').value.trim();
    await handleAddFriend(friendCode);
  };

  form.addEventListener('submit', handleSubmit);
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
