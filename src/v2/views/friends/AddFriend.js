/**
 * AddFriend View
 * - Show "My Link" with QR + shareable URL
 * - Input to paste friend's link
 * - Parse → befriend
 */
import { navigate } from '../index.js';

let cleanup = null;

export function render({ myLink = '', error = null, success = false, loading = false } = {}) {
  if (success) {
    return `
      <div class="view add-friend">
        <h1>Friend Request Sent!</h1>
        <div class="success">
          <p>Waiting for them to accept...</p>
        </div>
        <button id="done-btn">Done</button>
      </div>
    `;
  }

  return `
    <div class="view add-friend">
      <h1>Add Friend</h1>

      <section class="my-link-section">
        <h2>Share Your Link</h2>
        <div class="qr-placeholder" id="my-qr">
          <div class="qr-fallback">${myLink}</div>
        </div>
        <div class="link-display">
          <input type="text" readonly value="${myLink}" id="my-link-input" />
          <button id="copy-btn" class="secondary">Copy</button>
        </div>
      </section>

      <section class="add-section">
        <h2>Add Someone</h2>
        ${error ? `<div class="error">${error}</div>` : ''}
        <form id="add-form">
          <input
            type="text"
            id="friend-link"
            placeholder="Paste friend's link"
            required
            ${loading ? 'disabled' : ''}
          />
          <button type="submit" ${loading ? 'disabled' : ''}>
            ${loading ? 'Sending...' : 'Send Request'}
          </button>
        </form>
      </section>

      <p class="link"><a href="/friends" data-navigo>Back to Friends</a></p>
    </div>
  `;
}

/**
 * Parse obscura://add?userId=X&username=Y link
 */
function parseLink(link) {
  try {
    // Handle both obscura:// and https:// formats
    const url = new URL(link.replace('obscura://', 'https://obscura.app/'));
    const userId = url.searchParams.get('userId');
    const username = url.searchParams.get('username');

    if (!userId || !username) {
      throw new Error('Invalid link format');
    }

    return { userId, username };
  } catch (e) {
    throw new Error('Could not parse friend link');
  }
}

export function mount(container, client, router) {
  // Generate my link
  const myLink = `obscura://add?userId=${client.userId}&username=${client.username}`;

  container.innerHTML = render({ myLink });

  const form = container.querySelector('#add-form');
  const copyBtn = container.querySelector('#copy-btn');

  // Copy link handler
  copyBtn.addEventListener('click', async () => {
    const input = container.querySelector('#my-link-input');
    try {
      await navigator.clipboard.writeText(input.value);
      copyBtn.textContent = 'Copied!';
      setTimeout(() => {
        copyBtn.textContent = 'Copy';
      }, 2000);
    } catch (e) {
      input.select();
    }
  });

  // Submit handler
  const handleSubmit = async (e) => {
    e.preventDefault();

    const friendLink = container.querySelector('#friend-link').value.trim();

    try {
      const { userId, username } = parseLink(friendLink);

      container.innerHTML = render({ myLink, loading: true });

      await client.befriend(userId, username);

      container.innerHTML = render({ myLink, success: true });

      const doneBtn = container.querySelector('#done-btn');
      doneBtn.addEventListener('click', () => {
        navigate('/friends');
      });

    } catch (err) {
      container.innerHTML = render({ myLink, error: err.message });
      mount(container, client, router);
    }
  };

  form.addEventListener('submit', handleSubmit);
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
