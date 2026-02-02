/**
 * VerifyCode View
 * - Show your code and their code
 * - User compares out-of-band
 */
import { navigate } from '../index.js';

let cleanup = null;

export function render({ myCode = '----', theirCode = '----', username = 'friend', loading = false, showWarning = false } = {}) {
  return `
    <div class="view verify-code">
      <header>
        <a href="/friends/requests" data-navigo class="back">← Back</a>
        <h1>Verify ${username}</h1>
      </header>

      <p class="instructions">
        Compare these codes with ${username} in person or over a call.
        They should match exactly.
      </p>

      ${loading ? `
        <div class="loading">Loading codes...</div>
      ` : `
        <div class="code-comparison">
          <div class="code-box">
            <label>Your Code</label>
            <code class="safety-code">${myCode}</code>
          </div>

          <div class="code-box">
            <label>Their Code</label>
            <code class="safety-code">${theirCode}</code>
          </div>
        </div>

        ${showWarning ? `
          <div class="mismatch-warning">
            <h3>Security Warning</h3>
            <p>Code mismatch may indicate someone is impersonating ${username}.
               This could be a man-in-the-middle attack.</p>
            <div class="warning-actions">
              <button id="remove-friend-btn" class="danger">Remove Friend</button>
              <button id="go-back-btn" class="secondary">Go Back</button>
            </div>
          </div>
        ` : `
          <div class="verification-result">
            <button id="match-btn" class="primary">Codes Match ✓</button>
            <button id="no-match-btn" class="danger">Codes Don't Match ✗</button>
          </div>
        `}
      `}
    </div>
  `;
}

export async function mount(container, client, router, params) {
  const username = params.username || 'friend';
  const displayName = await client.getDisplayName(username);
  const req = window.__verifyRequest;

  container.innerHTML = render({ username: displayName, loading: true });

  // Get codes
  (async () => {
    try {
      const myCode = await client.getMyVerifyCode();
      const theirCode = req ? await req.getVerifyCode() : '----';

      container.innerHTML = render({ myCode, theirCode, username: displayName });

      // Match button - codes verified, go back to friends
      container.querySelector('#match-btn').addEventListener('click', () => {
        delete window.__verifyRequest;
        navigate('/friends');
      });

      // No match button - show warning instead of alert
      container.querySelector('#no-match-btn').addEventListener('click', () => {
        container.innerHTML = render({ myCode, theirCode, username: displayName, showWarning: true });

        container.querySelector('#remove-friend-btn').addEventListener('click', async () => {
          // Remove friend
          if (client.friends && client.friends.remove) {
            client.friends.remove(username);
          }
          delete window.__verifyRequest;
          navigate('/friends');
        });

        container.querySelector('#go-back-btn').addEventListener('click', () => {
          delete window.__verifyRequest;
          navigate('/friends');
        });

        router.updatePageLinks();
      });

      router.updatePageLinks();

    } catch (err) {
      container.innerHTML = `<div class="error">Failed to get verify codes: ${err.message}</div>`;
    }
  })();

  cleanup = () => {
    delete window.__verifyRequest;
  };
}

export function unmount() {
  if (cleanup) {
    cleanup();
    cleanup = null;
  }
}
