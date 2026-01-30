/**
 * Register View
 * - Username + password inputs
 * - On success: show recovery phrase, require confirmation
 */
import { Obscura } from '../../lib/index.js';
import { setClient, navigate, getApiUrl } from '../index.js';
import { fullSchema } from '../../lib/schema.js';

let cleanup = null;

export function render({ step = 'form', phrase = null } = {}) {
  if (step === 'phrase') {
    return `
      <div class="view register">
        <h1>Save Your Recovery Phrase</h1>
        <ry-alert type="warning" title="Important">
          Write these 12 words down and keep them safe. You'll need them to recover your account or revoke devices.
        </ry-alert>
        <card>
          <div class="phrase-box">
            ${phrase.split(' ').map((word, i) => `<span class="word"><b>${i + 1}.</b> ${word}</span>`).join('')}
          </div>
        </card>
        <stack gap="md">
          <label class="confirm-label">
            <input type="checkbox" id="confirm-saved" />
            I have saved my recovery phrase
          </label>
          <button id="continue-btn" disabled>Continue</button>
        </stack>
      </div>
    `;
  }

  return `
    <div class="view register">
      <h1>Create Account</h1>
      <form id="register-form">
        <stack gap="md">
          <ry-field label="Username">
            <input type="text" id="username" placeholder="Choose a username" required autocomplete="username" />
          </ry-field>
          <ry-field label="Password">
            <input type="password" id="password" placeholder="Create a password" required autocomplete="new-password" />
          </ry-field>
          <ry-field label="Confirm Password">
            <input type="password" id="confirm-password" placeholder="Confirm your password" required autocomplete="new-password" />
          </ry-field>
          <button type="submit">Register</button>
        </stack>
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
      RyToast.error('Passwords do not match');
      return;
    }

    if (password.length < 4) {
      RyToast.error('Password must be at least 4 characters');
      return;
    }

    try {
      const newClient = await Obscura.register(username, password, { apiUrl: getApiUrl() });
      const phrase = newClient.getRecoveryPhrase();

      // Show phrase confirmation step
      container.innerHTML = render({ step: 'phrase', phrase });

      const checkbox = container.querySelector('#confirm-saved');
      const continueBtn = container.querySelector('#continue-btn');

      checkbox.addEventListener('change', () => {
        continueBtn.disabled = !checkbox.checked;
      });

      continueBtn.addEventListener('click', async () => {
        try {
          await newClient.schema(fullSchema);
          await newClient.connect();
          setClient(newClient);
          navigate('/stories');
        } catch (err) {
          RyToast.error(err.message || 'Connection failed');
        }
      });

    } catch (err) {
      RyToast.error(err.message || 'Registration failed');
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
