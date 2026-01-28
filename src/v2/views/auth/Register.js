/**
 * Register View
 * - Username + password inputs
 * - On success: show recovery phrase, require confirmation
 */
import { Obscura } from '../../lib/index.js';
import { setClient, navigate } from '../index.js';

let cleanup = null;

export function render({ error = null, step = 'form', phrase = null } = {}) {
  if (step === 'phrase') {
    return `
      <div class="view register">
        <h1>Save Your Recovery Phrase</h1>
        <p class="warning">Write these 12 words down and keep them safe. You'll need them to recover your account or revoke devices.</p>
        <div class="phrase-box">
          ${phrase.split(' ').map((word, i) => `<span class="word"><b>${i + 1}.</b> ${word}</span>`).join('')}
        </div>
        <label class="confirm-label">
          <input type="checkbox" id="confirm-saved" />
          I have saved my recovery phrase
        </label>
        <button id="continue-btn" disabled>Continue</button>
      </div>
    `;
  }

  return `
    <div class="view register">
      <h1>Create Account</h1>
      ${error ? `<div class="error">${error}</div>` : ''}
      <form id="register-form">
        <input type="text" id="username" placeholder="Username" required autocomplete="username" />
        <input type="password" id="password" placeholder="Password" required autocomplete="new-password" />
        <input type="password" id="confirm-password" placeholder="Confirm Password" required autocomplete="new-password" />
        <button type="submit">Register</button>
      </form>
      <p class="link">Already have an account? <a href="/login" data-navigo>Login</a></p>
    </div>
  `;
}

export function mount(container, client, router) {
  container.innerHTML = render();

  const form = container.querySelector('#register-form');

  const handleSubmit = async (e) => {
    e.preventDefault();

    const username = container.querySelector('#username').value.trim();
    const password = container.querySelector('#password').value;
    const confirmPassword = container.querySelector('#confirm-password').value;

    if (password !== confirmPassword) {
      container.innerHTML = render({ error: 'Passwords do not match' });
      mount(container, client, router);
      return;
    }

    if (password.length < 4) {
      container.innerHTML = render({ error: 'Password must be at least 4 characters' });
      mount(container, client, router);
      return;
    }

    try {
      const apiUrl = import.meta.env.VITE_API_URL;
      const newClient = await Obscura.register(username, password, { apiUrl });
      const phrase = newClient.getRecoveryPhrase();

      // Show phrase confirmation step
      container.innerHTML = render({ step: 'phrase', phrase });

      const checkbox = container.querySelector('#confirm-saved');
      const continueBtn = container.querySelector('#continue-btn');

      checkbox.addEventListener('change', () => {
        continueBtn.disabled = !checkbox.checked;
      });

      continueBtn.addEventListener('click', async () => {
        setClient(newClient);
        await newClient.connect();
        navigate('/stories');
      });

    } catch (err) {
      container.innerHTML = render({ error: err.message });
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
