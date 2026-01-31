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
      <p>Open Obscura on another device and enter this code to approve.</p>

      <div class="link-code-section" style="margin: var(--ry-space-6) 0;">
        <ry-field label="Link Code">
          <div style="display: flex; gap: var(--ry-space-2);">
            <input
              type="text"
              class="link-code"
              value="${linkCode}"
              readonly
              style="font-family: monospace; font-size: 0.75rem;"
            />
            <button type="button" id="copy-btn" variant="secondary">Copy</button>
          </div>
        </ry-field>
      </div>

      ${waiting ? `
        <div class="waiting" style="text-align: center; margin: var(--ry-space-6) 0;">
          <div class="spinner"></div>
          <p>Waiting for approval...</p>
        </div>
      ` : `
        <div class="approved" style="text-align: center;">
          <p>Approved! Syncing data...</p>
        </div>
      `}

      <p class="link" style="text-align: center;"><a href="/login" data-navigo>Cancel</a></p>
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

  // Copy button handler
  const copyBtn = container.querySelector('#copy-btn');
  const codeInput = container.querySelector('.link-code');
  if (copyBtn && codeInput) {
    copyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(codeInput.value);
        copyBtn.textContent = 'Copied!';
        setTimeout(() => { copyBtn.textContent = 'Copy'; }, 2000);
      } catch (e) {
        codeInput.select();
      }
    });
  }

  let approvalHandler = null;
  let syncHandler = null;

  try {
    // 1. Define schema FIRST so ORM models exist when SYNC_BLOB arrives
    await pendingClient.schema(fullSchema);

    // 2. Connect - this starts receiving from the dumb pipe
    await pendingClient.connect();

    // 3. Register BOTH handlers AFTER connect (they're live now)
    approvalHandler = (approval) => {
      // Don't re-render - avoids ry-field custom element lifecycle error
      // Just show visual feedback without replacing DOM
      const waitingDiv = container.querySelector('.waiting');
      if (waitingDiv) {
        waitingDiv.innerHTML = '<p>Approved! Syncing data...</p>';
      }
      approval.apply();
    };

    syncHandler = async () => {
      try {
        // Schema already defined before connect, just clean up and navigate
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
