/**
 * LinkPending View
 * - New device waiting for approval from existing device
 * - Shows linkCode as QR + text
 * - Listens for linkApproval event
 */
import { setClient, navigate } from '../index.js';

let cleanup = null;
let client = null;

export function render({ linkCode = '', waiting = true } = {}) {
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

export function mount(container, _client, router) {
  // Get pending client from login flow
  client = window.__pendingClient;

  if (!client) {
    navigate('/login');
    return;
  }

  container.innerHTML = render({ linkCode: client.linkCode });

  // Listen for approval
  const handleApproval = async (approval) => {
    container.innerHTML = render({ linkCode: client.linkCode, waiting: false });

    // Apply the approval
    approval.apply();

    // Wait for sync blob
    client.on('syncBlob', async () => {
      // Clean up temp storage
      delete window.__pendingClient;

      // Set as active client and navigate
      setClient(client);
      navigate('/stories');
    });
  };

  client.on('linkApproval', handleApproval);
  router.updatePageLinks();

  cleanup = () => {
    if (client) {
      client.off('linkApproval', handleApproval);
    }
  };
}

export function unmount() {
  if (cleanup) {
    cleanup();
    cleanup = null;
  }
}
