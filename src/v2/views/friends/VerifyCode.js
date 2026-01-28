/**
 * VerifyCode View
 * - Show your code and their code
 * - User compares out-of-band
 */
import { navigate } from '../index.js';

let cleanup = null;

export function render({ myCode = '----', theirCode = '----', username = 'friend', loading = false } = {}) {
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

        <div class="verification-result">
          <button id="match-btn" class="success">Codes Match ✓</button>
          <button id="no-match-btn" class="danger">Codes Don't Match ✗</button>
        </div>
      `}
    </div>
  `;
}

export function mount(container, client, router, params) {
  const username = params.username || 'friend';
  const req = window.__verifyRequest;

  container.innerHTML = render({ username, loading: true });

  // Get codes
  (async () => {
    try {
      const myCode = await client.getMyVerifyCode();
      const theirCode = req ? await req.getVerifyCode() : '----';

      container.innerHTML = render({ myCode, theirCode, username });

      // Match button
      container.querySelector('#match-btn').addEventListener('click', () => {
        // Codes verified - could mark as verified in UI
        delete window.__verifyRequest;
        navigate('/friends');
      });

      // No match button
      container.querySelector('#no-match-btn').addEventListener('click', () => {
        // Warning: potential MITM
        alert('Warning: Code mismatch may indicate a security issue. Consider rejecting this friend request.');
        delete window.__verifyRequest;
        navigate('/friends/requests');
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
