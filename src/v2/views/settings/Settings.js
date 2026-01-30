/**
 * Settings View
 * - Theme toggle
 * - Notifications toggle
 * - Link to devices
 * - Logout
 */
import { navigate, clearClient } from '../index.js';
import { renderNav, initNav } from '../components/Nav.js';
import { ObscuraClient } from '../../lib/ObscuraClient.js';

let cleanup = null;

export function render({ settings = null, loading = false, saving = false } = {}) {
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
              <button id="request-sync" variant="ghost">
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

        <section class="settings-group danger">
          <h2>Account</h2>
          <button variant="danger" modal="logout-modal">Log Out</button>
        </section>
      </stack>

      <ry-modal id="logout-modal" title="Confirm Logout">
        <p>Are you sure you want to log out?</p>
        <actions slot="footer">
          <button variant="ghost" close>Cancel</button>
          <button variant="danger" id="confirm-logout">Logout</button>
        </actions>
      </ry-modal>

      ${renderNav('more')}
    </div>
  `;
}

export async function mount(container, client, router) {
  container.innerHTML = render({ loading: true });

  let settings = null;
  let settingsId = null;

  try {
    if (client.settings) {
      settings = await client.settings.where({}).first();
      if (settings) {
        settingsId = settings.id;
      }
    }

    container.innerHTML = render({ settings });

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

    // Logout - modal handles confirmation, just attach to confirm button
    const confirmLogout = container.querySelector('#confirm-logout');
    confirmLogout.addEventListener('click', () => {
      client.disconnect();
      ObscuraClient.clearSession();
      clearClient();
      navigate('/login');
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
