/**
 * Recover View
 * 4-step flow to recover account from encrypted backup:
 * 1. Upload backup file (or restore from server backup)
 * 2. Enter recovery phrase + password
 * 3. Choose recovery mode (add device vs replace all)
 * 4. Processing
 */
import { setClient, navigate, getApiUrl } from '../index.js';
import { fullSchema } from '../../lib/schema.js';
import { decryptBackup } from '../../crypto/backup.js';
import { recoverAccount } from '../../lib/auth.js';
import { ObscuraClient } from '../../lib/index.js';
import { createClient } from '../../api/client.js';

let cleanup = null;

const BACKUP_MAGIC = 'OBSCURA_BACKUP';

export function render({ step = 'upload', error = null, loading = false, username = null, serverBackup = null } = {}) {
  // Step 1: Upload backup file
  if (step === 'upload') {
    return `
      <div class="view recover">
        <h1>Recover Account</h1>
        <p>Upload your backup file to restore your account.</p>
        ${error ? `<ry-alert type="error">${error}</ry-alert>` : ''}
        ${serverBackup ? `
          <card style="margin-bottom: var(--ry-space-4);">
            <stack gap="sm">
              <p><strong>Server backup found</strong>${serverBackup.size ? ` (${Math.round(serverBackup.size / 1024)} KB)` : ''}</p>
              <button type="button" id="restore-from-server" ${loading ? 'disabled' : ''}>
                ${loading ? 'Downloading...' : 'Restore from server backup'}
              </button>
            </stack>
          </card>
          <p style="text-align: center; color: var(--ry-color-text-muted);">Or upload a local backup file:</p>
        ` : ''}
        <form id="upload-form">
          <stack gap="md">
            <ry-field label="Backup File">
              <input type="file" id="backup-file" accept=".obscura" required />
            </ry-field>
            <button type="submit">Continue</button>
          </stack>
        </form>
        <p class="link"><a href="/login" data-navigo>Back to Login</a></p>
      </div>
    `;
  }

  // Step 2: Enter phrase and password
  if (step === 'phrase') {
    return `
      <div class="view recover">
        <h1>Enter Recovery Phrase</h1>
        <p>Enter your 12-word recovery phrase and create a password for this device.</p>
        ${error ? `<ry-alert type="error">${error}</ry-alert>` : ''}
        <form id="phrase-form">
          <stack gap="md">
            <label>Recovery Phrase</label>
            <div class="phrase-grid">
              ${[1,2,3,4,5,6,7,8,9,10,11,12].map(i => `
                <div class="phrase-input-wrapper">
                  <span class="phrase-number">${i}</span>
                  <input
                    type="text"
                    class="phrase-word"
                    data-index="${i}"
                    autocomplete="off"
                    autocapitalize="none"
                    ${loading ? 'disabled' : ''}
                  />
                </div>
              `).join('')}
            </div>
            <ry-field label="Password for this device">
              <input type="password" id="password" required
                placeholder="Create a password"
                autocomplete="new-password"
                ${loading ? 'disabled' : ''} />
            </ry-field>
            <button type="submit" ${loading ? 'disabled' : ''}>
              ${loading ? 'Decrypting...' : 'Continue'}
            </button>
          </stack>
        </form>
        <p class="link"><a href="/login" data-navigo>Back to Login</a></p>
      </div>
    `;
  }

  // Step 3: Choose recovery mode
  if (step === 'mode') {
    return `
      <div class="view recover">
        <h1>Recovery Mode</h1>
        <p>How do you want to recover your account${username ? ` (${username})` : ''}?</p>
        ${error ? `<ry-alert type="error">${error}</ry-alert>` : ''}
        <form id="mode-form">
          <stack gap="md">
            <card class="mode-option">
              <label>
                <input type="radio" name="mode" value="add" />
                <strong>Add as new device</strong>
                <p class="hint">Keep your other devices active. Use this if you just want to restore your data and your other devices are still safe.</p>
              </label>
            </card>
            <card class="mode-option">
              <label>
                <input type="radio" name="mode" value="replace" checked />
                <strong>Replace all devices</strong>
                <p class="hint warning">⚠️ Recommended if device was lost or stolen. All other devices will be revoked immediately. Any messages or data synced after this backup was created will be lost permanently.</p>
              </label>
            </card>
            <button type="submit" ${loading ? 'disabled' : ''}>
              ${loading ? 'Recovering...' : 'Recover Account'}
            </button>
          </stack>
        </form>
        <p class="link"><a href="/login" data-navigo>Back to Login</a></p>
      </div>
    `;
  }

  // Step 4: Processing
  if (step === 'processing') {
    return `
      <div class="view recover">
        <h1>Recovering...</h1>
        <p>Please wait while we restore your account.</p>
        <div class="loading-spinner"></div>
      </div>
    `;
  }
}

export function mount(container, client, router) {
  let backupFileData = null;
  let backupData = null;
  let recoveryPhrase = null;
  let password = null;
  let isWebBackup = false;

  // Check for pending client (user came from link-pending)
  const pendingClient = window.__pendingClient;
  let serverBackup = null;

  container.innerHTML = render({ step: 'upload' });
  router.updatePageLinks();

  if (pendingClient) {
    checkServerBackup();
  } else {
    setupUploadStep();
  }

  async function checkServerBackup() {
    try {
      const apiClient = createClient(pendingClient.apiUrl);
      apiClient.setToken(pendingClient.shellToken || pendingClient.token);
      const check = await apiClient.checkBackup();
      if (check.exists) {
        serverBackup = { size: check.size, etag: check.etag, apiClient };
        container.innerHTML = render({ step: 'upload', serverBackup });
        router.updatePageLinks();
        setupUploadStep();
        setupServerRestoreButton();
        return;
      }
    } catch (err) {
      console.error('[Recover] Failed to check server backup:', err);
    }
    setupUploadStep();
  }

  function setupServerRestoreButton() {
    const btn = container.querySelector('#restore-from-server');
    if (!btn) return;

    btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.textContent = 'Downloading...';
      try {
        const result = await serverBackup.apiClient.downloadBackup();
        if (!result?.data) throw new Error('No backup data received');

        backupFileData = result.data;
        isWebBackup = true;

        container.innerHTML = render({ step: 'phrase' });
        router.updatePageLinks();
        setupPhraseStep();
      } catch (err) {
        container.innerHTML = render({ step: 'upload', error: err.message, serverBackup });
        router.updatePageLinks();
        setupUploadStep();
        setupServerRestoreButton();
      }
    });
  }

  // Step 1: Handle file upload
  function setupUploadStep() {
    const uploadForm = container.querySelector('#upload-form');
    if (!uploadForm) return;

    const handleUpload = async (e) => {
      e.preventDefault();
      const fileInput = container.querySelector('#backup-file');
      const file = fileInput.files[0];
      if (!file) return;

      try {
        backupFileData = new Uint8Array(await file.arrayBuffer());
        isWebBackup = false;

        // Validate file format (check magic header)
        const magicBytes = new TextEncoder().encode(BACKUP_MAGIC);
        const fileMagic = new TextDecoder().decode(backupFileData.slice(0, magicBytes.length));
        if (fileMagic !== BACKUP_MAGIC) {
          throw new Error('Invalid backup file format');
        }

        // Move to phrase step
        container.innerHTML = render({ step: 'phrase' });
        router.updatePageLinks();
        setupPhraseStep();
      } catch (err) {
        container.innerHTML = render({ step: 'upload', error: err.message, serverBackup });
        router.updatePageLinks();
        setupUploadStep();
        if (serverBackup) setupServerRestoreButton();
      }
    };

    uploadForm.addEventListener('submit', handleUpload);
    cleanup = () => uploadForm.removeEventListener('submit', handleUpload);
  }

  function setupPhraseStep() {
    const phraseForm = container.querySelector('#phrase-form');
    if (!phraseForm) return;

    const inputs = container.querySelectorAll('.phrase-word');

    // Handle paste of full phrase into any input
    inputs.forEach((input, idx) => {
      input.addEventListener('paste', (e) => {
        const pasted = e.clipboardData.getData('text').trim();
        const words = pasted.split(/\s+/);
        if (words.length > 1) {
          e.preventDefault();
          // Distribute words across inputs starting from current
          words.forEach((word, i) => {
            if (inputs[idx + i]) {
              inputs[idx + i].value = word.toLowerCase();
            }
          });
          // Focus last filled or next empty
          const lastIdx = Math.min(idx + words.length - 1, 11);
          inputs[lastIdx].focus();
        }
      });

      // Auto-advance on space or after word entry
      input.addEventListener('keydown', (e) => {
        if (e.key === ' ' || e.key === 'Tab') {
          if (e.key === ' ') e.preventDefault();
          if (idx < 11 && input.value.trim()) {
            inputs[idx + 1].focus();
          }
        } else if (e.key === 'Backspace' && !input.value && idx > 0) {
          inputs[idx - 1].focus();
        }
      });

      // Clean input on change
      input.addEventListener('input', () => {
        input.value = input.value.toLowerCase().replace(/[^a-z]/g, '');
      });
    });

    const handlePhrase = async (e) => {
      e.preventDefault();

      // Collect words from all 12 inputs
      const words = Array.from(inputs).map(i => i.value.trim().toLowerCase());
      const filledWords = words.filter(w => w);

      if (filledWords.length !== 12) {
        container.innerHTML = render({ step: 'phrase', error: 'Please enter all 12 words' });
        router.updatePageLinks();
        setupPhraseStep();
        return;
      }

      recoveryPhrase = words.join(' ');
      password = container.querySelector('#password').value;

      container.innerHTML = render({ step: 'phrase', loading: true });

      try {
        if (isWebBackup) {
          // Web backup: no file header, compressed inside encryption
          const { decompress } = await import('../../crypto/compress.js');
          const compressed = await decryptBackup(backupFileData, recoveryPhrase);
          backupData = await decompress(compressed);
        } else {
          // Local backup: strip magic header + version byte
          const magicBytes = new TextEncoder().encode(BACKUP_MAGIC);
          const encryptedData = backupFileData.slice(magicBytes.length + 1);
          backupData = await decryptBackup(encryptedData, recoveryPhrase);
        }

        // Move to mode selection step
        container.innerHTML = render({ step: 'mode', username: backupData.username });
        router.updatePageLinks();
        setupModeStep();
      } catch (err) {
        let errorMsg = err.message;
        if (errorMsg.includes('decrypt') || errorMsg.includes('authentication')) {
          errorMsg = 'Invalid recovery phrase. Please check your 12 words and try again.';
        }
        container.innerHTML = render({ step: 'phrase', error: errorMsg });
        router.updatePageLinks();
        setupPhraseStep();
      }
    };

    phraseForm.addEventListener('submit', handlePhrase);
    cleanup = () => phraseForm.removeEventListener('submit', handlePhrase);
  }

  function setupModeStep() {
    const modeForm = container.querySelector('#mode-form');
    if (!modeForm) return;

    const handleMode = async (e) => {
      e.preventDefault();

      const mode = container.querySelector('input[name="mode"]:checked')?.value;
      const revokeOthers = mode === 'replace';

      container.innerHTML = render({ step: 'processing' });

      try {
        const apiUrl = getApiUrl();

        // Clear any existing session
        ObscuraClient.clearSession();

        // Recover account
        const result = await recoverAccount(
          backupData.username,
          password,
          backupData,
          recoveryPhrase,
          { apiUrl, revokeOthers }
        );

        // Set up client
        await result.client.schema(fullSchema);
        await result.client.connect();

        // Announce recovery to friends
        await result.client.announceRecovery(recoveryPhrase, revokeOthers);

        setClient(result.client);
        RyToast.success('Account recovered successfully!');
        navigate('/stories');

      } catch (err) {
        container.innerHTML = render({ step: 'mode', error: err.message, username: backupData?.username });
        router.updatePageLinks();
        setupModeStep();
      }
    };

    modeForm.addEventListener('submit', handleMode);
    cleanup = () => modeForm.removeEventListener('submit', handleMode);
  }
}

export function unmount() {
  if (cleanup) {
    cleanup();
    cleanup = null;
  }
}
