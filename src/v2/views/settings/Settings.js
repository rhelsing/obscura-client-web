/**
 * Settings View
 * - Theme toggle
 * - Notifications toggle
 * - Link to devices
 * - Backup & Recovery
 * - Logout
 */
import { navigate, clearClient, getBadgeCounts } from '../index.js';
import { renderNav, initNav } from '../components/Nav.js';
import { ObscuraClient } from '../../lib/ObscuraClient.js';
import { unlinkDevice } from '../../lib/auth.js';
import { createBackupManager } from '../../backup/BackupManager.js';

let cleanup = null;

export function render({ settings = null, loading = false, saving = false, isFirstDevice = false } = {}) {
  if (loading) {
    return `<div class="view settings"><div class="loading">Loading...</div></div>`;
  }

  const notifications = settings?.data?.notificationsEnabled ?? true;

  return `
    <div class="view settings">
      <header>
        <h1>Settings</h1>
      </header>

      <stack gap="lg">
        <section class="settings-group">
          <h2>Notifications</h2>
          <card>
            <ry-switch id="notifications-toggle" ${notifications ? 'checked' : ''} ${saving ? 'disabled' : ''}>
              Enable Notifications
            </ry-switch>
          </card>
        </section>

        <section class="settings-group">
          <h2>Devices</h2>
          <stack gap="sm">
            <card>
              <a href="/devices" data-navigo>
                <cluster>
                  <span>Manage Devices</span>
                  <ry-icon name="chevron-right"></ry-icon>
                </cluster>
              </a>
            </card>
            <card>
              <a href="/link-device" data-navigo>
                <cluster>
                  <span>Link New Device</span>
                  <ry-icon name="chevron-right"></ry-icon>
                </cluster>
              </a>
            </card>
            <card>
              <button id="request-sync" variant="ghost" style="display: none;">
                <cluster>
                  <span>Request Full Sync</span>
                  <ry-icon name="refresh-cw"></ry-icon>
                </cluster>
              </button>
            </card>
          </stack>
        </section>

        <section class="settings-group">
          <h2>Profile</h2>
          <stack gap="sm">
            <card>
              <a href="/profile" data-navigo>
                <cluster>
                  <span>View Profile</span>
                  <ry-icon name="chevron-right"></ry-icon>
                </cluster>
              </a>
            </card>
            <card>
              <a href="/profile/edit" data-navigo>
                <cluster>
                  <span>Edit Profile</span>
                  <ry-icon name="chevron-right"></ry-icon>
                </cluster>
              </a>
            </card>
          </stack>
        </section>

        <section class="settings-group">
          <h2>Backup & Recovery</h2>
          <stack gap="sm">
            <card>
              <button id="export-backup" variant="ghost">
                <cluster>
                  <span>Export Backup</span>
                  <ry-icon name="download"></ry-icon>
                </cluster>
              </button>
              <p class="hint">Download an encrypted backup of your account. You'll need your 12-word recovery phrase to restore it.</p>
            </card>
            <card>
              <button id="import-backup" variant="ghost" modal="import-backup-modal" style="display: none;">
                <cluster>
                  <span>Restore from Backup</span>
                  <ry-icon name="upload"></ry-icon>
                </cluster>
              </button>
              <p class="hint">Restore your account from a backup file using your recovery phrase.</p>
            </card>
          </stack>
        </section>

        <section class="settings-group">
          <h2>Security</h2>
          <stack gap="sm">
            <card>
              <button id="reset-sessions" variant="ghost" style="display: none;">
                <cluster>
                  <span>Reset All Sessions</span>
                  <ry-icon name="refresh-cw"></ry-icon>
                </cluster>
              </button>
              <p class="hint">Reset encrypted sessions with all contacts and devices. Use if experiencing decryption errors.</p>
            </card>
          </stack>
        </section>

        <section class="settings-group danger">
          <h2>Account</h2>
          <stack gap="sm">
            <button variant="danger" modal="logout-modal">Log Out</button>
            ${!isFirstDevice ? '<button variant="danger" modal="unlink-modal">Unlink Device</button>' : ''}
          </stack>
        </section>
      </stack>

      <ry-modal id="reset-sessions-modal" title="Reset All Sessions">
        <p>This will reset encrypted sessions with all your contacts and your other devices.</p>
        <p>Recent messages may need to be re-sent after reset.</p>
        <actions slot="footer">
          <button variant="ghost" close>Cancel</button>
          <button variant="primary" id="confirm-reset-sessions">Reset Sessions</button>
        </actions>
      </ry-modal>

      <ry-modal id="logout-modal" title="Confirm Logout">
        <p>Are you sure you want to log out?</p>
        <actions slot="footer">
          <button variant="ghost" close>Cancel</button>
          <button variant="danger" id="confirm-logout">Logout</button>
        </actions>
      </ry-modal>

      <ry-modal id="unlink-modal" title="Unlink Device">
        <p>This will erase all local data for this account on this device.</p>
        <p>You will need to link this device again from another device to use this account here.</p>
        <actions slot="footer">
          <button variant="ghost" close>Cancel</button>
          <button variant="danger" id="confirm-unlink">Unlink</button>
        </actions>
      </ry-modal>

      <ry-modal id="import-backup-modal" title="Restore from Backup">
        <stack gap="md">
          <div>
            <label for="backup-file">Backup File</label>
            <input type="file" id="backup-file" accept=".obscura" />
          </div>
          <div>
            <label for="recovery-phrase">Recovery Phrase (12 words)</label>
            <textarea id="recovery-phrase" rows="3" placeholder="Enter your 12-word recovery phrase..."></textarea>
          </div>
          <div>
            <label for="restore-password">Account Password</label>
            <input type="password" id="restore-password" placeholder="Your account password" />
          </div>
          <p class="hint">This will replace all local data with the backup contents.</p>
          <p id="import-error" class="error" style="display: none;"></p>
        </stack>
        <actions slot="footer">
          <button variant="ghost" close>Cancel</button>
          <button variant="primary" id="confirm-import">Restore Backup</button>
        </actions>
      </ry-modal>

      ${renderNav('more', getBadgeCounts())}
    </div>
  `;
}

export async function mount(container, client, router) {
  container.innerHTML = render({ loading: true });

  let settings = null;
  let settingsId = null;

  try {
    // Check if this is the first device (primary device cannot be unlinked)
    const deviceIdentity = await client.store.getDeviceIdentity();
    const isFirstDevice = deviceIdentity?.isFirstDevice ?? false;

    if (client.settings) {
      settings = await client.settings.where({}).first();
      if (settings) {
        settingsId = settings.id;
      }
    }

    container.innerHTML = render({ settings, isFirstDevice });

    // Notifications toggle - listen for ry:change event from switch
    const notifToggle = container.querySelector('#notifications-toggle');
    notifToggle.addEventListener('ry:change', async (e) => {
      if (client.settings) {
        try {
          const data = {
            notificationsEnabled: e.detail.checked
          };

          if (settingsId) {
            await client.settings.upsert(settingsId, data);
          } else {
            const created = await client.settings.create(data);
            settingsId = created.id;
          }
        } catch (err) {
          console.error('Failed to save settings:', err);
        }
      }
    });

    // Request sync button
    const requestSyncBtn = container.querySelector('#request-sync');
    requestSyncBtn.addEventListener('click', async () => {
      requestSyncBtn.disabled = true;
      requestSyncBtn.querySelector('span').textContent = 'Requesting...';

      try {
        const count = await client.requestSync();
        requestSyncBtn.querySelector('span').textContent = `Requested from ${count} device${count > 1 ? 's' : ''}`;
        setTimeout(() => {
          requestSyncBtn.querySelector('span').textContent = 'Request Full Sync';
          requestSyncBtn.disabled = false;
        }, 3000);
      } catch (err) {
        requestSyncBtn.querySelector('span').textContent = err.message;
        setTimeout(() => {
          requestSyncBtn.querySelector('span').textContent = 'Request Full Sync';
          requestSyncBtn.disabled = false;
        }, 3000);
      }
    });

    // Export backup button
    const exportBackupBtn = container.querySelector('#export-backup');
    exportBackupBtn.addEventListener('click', async () => {
      exportBackupBtn.disabled = true;
      exportBackupBtn.querySelector('span').textContent = 'Exporting...';

      try {
        const backupManager = createBackupManager(client.username, client.userId);
        const { blob, filename } = await backupManager.exportBackup();
        backupManager.close();

        // Trigger download
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        exportBackupBtn.querySelector('span').textContent = 'Backup Downloaded';
        setTimeout(() => {
          exportBackupBtn.querySelector('span').textContent = 'Export Backup';
          exportBackupBtn.disabled = false;
        }, 3000);
      } catch (err) {
        console.error('Failed to export backup:', err);
        exportBackupBtn.querySelector('span').textContent = 'Export Failed';
        setTimeout(() => {
          exportBackupBtn.querySelector('span').textContent = 'Export Backup';
          exportBackupBtn.disabled = false;
        }, 3000);
      }
    });

    // Import backup modal
    const importBackupModal = container.querySelector('#import-backup-modal');
    const confirmImportBtn = container.querySelector('#confirm-import');
    const backupFileInput = container.querySelector('#backup-file');
    const recoveryPhraseInput = container.querySelector('#recovery-phrase');
    const restorePasswordInput = container.querySelector('#restore-password');
    const importError = container.querySelector('#import-error');

    confirmImportBtn.addEventListener('click', async () => {
      importError.style.display = 'none';

      const file = backupFileInput.files[0];
      const phrase = recoveryPhraseInput.value.trim();
      const password = restorePasswordInput.value;

      if (!file) {
        importError.textContent = 'Please select a backup file';
        importError.style.display = 'block';
        return;
      }

      if (!phrase) {
        importError.textContent = 'Please enter your recovery phrase';
        importError.style.display = 'block';
        return;
      }

      if (!password) {
        importError.textContent = 'Please enter your account password';
        importError.style.display = 'block';
        return;
      }

      confirmImportBtn.disabled = true;
      confirmImportBtn.textContent = 'Restoring...';

      try {
        const fileData = await file.arrayBuffer();
        const backupManager = createBackupManager(client.username, client.userId);
        const result = await backupManager.importBackup(new Uint8Array(fileData), phrase, password);
        backupManager.close();

        importBackupModal.close();
        alert(`Backup restored successfully!\n\nDevices: ${result.deviceCount}\nFriends: ${result.friendCount}\nMessages: ${result.messageCount}\n\nPlease log in again to use your restored account.`);

        // Disconnect and redirect to login
        client.disconnect();
        ObscuraClient.clearSession();
        clearClient();
        navigate('/login');
      } catch (err) {
        console.error('Failed to import backup:', err);
        importError.textContent = err.message || 'Failed to restore backup';
        importError.style.display = 'block';
      } finally {
        confirmImportBtn.disabled = false;
        confirmImportBtn.textContent = 'Restore Backup';
      }
    });

    // Reset sessions button - show modal
    const resetSessionsBtn = container.querySelector('#reset-sessions');
    const resetSessionsModal = container.querySelector('#reset-sessions-modal');
    resetSessionsBtn.addEventListener('click', () => {
      resetSessionsModal.show();
    });

    // Confirm reset sessions
    const confirmResetSessions = container.querySelector('#confirm-reset-sessions');
    confirmResetSessions.addEventListener('click', async () => {
      confirmResetSessions.disabled = true;
      confirmResetSessions.textContent = 'Resetting...';

      try {
        const count = await client.resetAllSessions('user_initiated');
        resetSessionsModal.close();
        resetSessionsBtn.querySelector('span').textContent = `Reset ${count} session${count !== 1 ? 's' : ''}`;
        setTimeout(() => {
          resetSessionsBtn.querySelector('span').textContent = 'Reset All Sessions';
        }, 3000);
      } catch (err) {
        console.error('Failed to reset sessions:', err);
        resetSessionsModal.close();
        resetSessionsBtn.querySelector('span').textContent = 'Reset failed';
        setTimeout(() => {
          resetSessionsBtn.querySelector('span').textContent = 'Reset All Sessions';
        }, 3000);
      } finally {
        confirmResetSessions.disabled = false;
        confirmResetSessions.textContent = 'Reset Sessions';
      }
    });

    // Logout - modal handles confirmation, just attach to confirm button
    const confirmLogout = container.querySelector('#confirm-logout');
    confirmLogout.addEventListener('click', () => {
      client.disconnect();
      ObscuraClient.clearSession();
      clearClient();
      navigate('/login');
    });

    // Unlink device - wipes all local data (only shown for non-first devices)
    const confirmUnlink = container.querySelector('#confirm-unlink');
    confirmUnlink?.addEventListener('click', async () => {
      confirmUnlink.disabled = true;
      confirmUnlink.textContent = 'Unlinking...';

      try {
        // 1. Close WebSocket
        client.disconnect();

        // 2. Close all IndexedDB connections (so deletes aren't blocked)
        if (client.store?.close) client.store.close();
        if (client._friendStore?.close) client._friendStore.close();
        if (client._deviceStore?.close) client._deviceStore.close();
        if (client.messageStore?.close) client.messageStore.close();
        if (client._attachmentStore?.close) client._attachmentStore.close();

        // 3. Delete all user databases (now unblocked)
        await unlinkDevice(client.username, client.userId);

        // 4. Clear session and navigate
        ObscuraClient.clearSession();
        clearClient();
        navigate('/login');
      } catch (err) {
        console.error('Failed to unlink device:', err);
        confirmUnlink.textContent = 'Failed';
        setTimeout(() => {
          confirmUnlink.disabled = false;
          confirmUnlink.textContent = 'Unlink';
        }, 2000);
      }
    });

    // Init nav
    initNav(container, () => {
      client.disconnect();
      ObscuraClient.clearSession();
      clearClient();
      navigate('/login');
    });

    router.updatePageLinks();

  } catch (err) {
    container.innerHTML = `<div class="error">Failed to load settings: ${err.message}</div>`;
  }

  cleanup = () => {};
}

export function unmount() {
  if (cleanup) {
    cleanup();
    cleanup = null;
  }
}
