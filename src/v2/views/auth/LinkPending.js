/**
 * LinkPending View
 * - New device waiting for approval from existing device
 * - Shows linkCode as QR + text
 * - Listens for linkApproval event
 *
 * IMPORTANT: Must connect() FIRST, then register handlers.
 * The server dumps all queued messages on connect (dumb pipe).
 */
import { setClient, navigate } from '../index.js';
import { fullSchema } from '../../lib/schema.js';

let cleanup = null;
let pendingClient = null;

export function render({ linkCode = '', waiting = true, error = null } = {}) {
  if (error) {
    return `
      <div class="view link-pending">
        <h1>Link Failed</h1>
        <div class="error">${error}</div>
        <p class="link"><a href="/login" data-navigo>Back to Login</a></p>
      </div>
    `;
  }

  return `
    <div class="view link-pending">
      <h1>Link This Device</h1>
      <p>Open Obscura on another device and approve this link request.</p>

      <div class="link-code-section">
        <div class="qr-placeholder" id="qr-code">
          <!-- QR code would go here -->
          <div class="qr-fallback">${linkCode}</div>
        </div>

        <div class="code-display">
          <label>Or enter this code:</label>
          <code class="link-code">${linkCode}</code>
        </div>
      </div>

      ${waiting ? `
        <div class="waiting">
          <div class="spinner"></div>
          <p>Waiting for approval...</p>
        </div>
      ` : `
        <div class="approved">
          <p>Approved! Syncing data...</p>
        </div>
      `}

      <p class="link"><a href="/login" data-navigo>Cancel</a></p>
    </div>
  `;
}

export async function mount(container, _client, router) {
  // Get pending client from login flow
  pendingClient = window.__pendingClient;

  if (!pendingClient) {
    navigate('/login');
    return;
  }

  container.innerHTML = render({ linkCode: pendingClient.linkCode });

  let approvalHandler = null;
  let syncHandler = null;

  try {
    // 1. Connect FIRST - this starts receiving from the dumb pipe
    await pendingClient.connect();

    // 2. Register BOTH handlers AFTER connect (they're live now)
    approvalHandler = (approval) => {
      container.innerHTML = render({ linkCode: pendingClient.linkCode, waiting: false });
      approval.apply();
    };

    syncHandler = async () => {
      try {
        // 3. Define schema AFTER receiving sync blob
        await pendingClient.schema(fullSchema);

        // Clean up temp storage
        delete window.__pendingClient;

        // Set as active client and navigate
        setClient(pendingClient);
        navigate('/stories');
      } catch (err) {
        console.error('Failed to initialize after sync:', err);
        container.innerHTML = render({ error: err.message });
      }
    };

    pendingClient.on('linkApproval', approvalHandler);
    pendingClient.on('syncBlob', syncHandler);

  } catch (err) {
    console.error('Failed to connect:', err);
    container.innerHTML = render({ error: 'Failed to connect: ' + err.message });
  }

  router.updatePageLinks();

  cleanup = () => {
    if (pendingClient) {
      if (approvalHandler) pendingClient.off('linkApproval', approvalHandler);
      if (syncHandler) pendingClient.off('syncBlob', syncHandler);
    }
  };
}

export function unmount() {
  if (cleanup) {
    cleanup();
    cleanup = null;
  }
}
