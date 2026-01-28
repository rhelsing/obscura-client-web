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

  const theme = settings?.data?.theme || 'light';
  const notifications = settings?.data?.notificationsEnabled ?? true;

  return `
    <div class="view settings">
      <header>
        <h1>Settings</h1>
      </header>

      <stack gap="lg">
        <section class="settings-group">
          <h2>Appearance</h2>
          <card>
            <cluster>
              <span>Theme</span>
              <ry-theme-toggle id="theme-toggle" themes="light,dark"></ry-theme-toggle>
            </cluster>
          </card>
        </section>

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

    // Theme toggle - ry-theme-toggle auto-handles the toggle
    // Listen for theme change to save to ORM
    const themeToggle = container.querySelector('#theme-toggle');
    if (themeToggle) {
      // ry-theme-toggle emits ry:change when theme changes
      themeToggle.addEventListener('ry:change', async (e) => {
        const newTheme = e.detail?.theme || document.documentElement.getAttribute('data-ry-theme') || 'light';
        localStorage.setItem('ry-theme', newTheme);

        // Save to ORM
        if (client.settings) {
          try {
            const notifToggle = container.querySelector('#notifications-toggle');
            const data = {
              theme: newTheme,
              notificationsEnabled: notifToggle?.checked ?? true
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
    }

    // Notifications toggle - listen for ry:change event from switch
    const notifToggle = container.querySelector('#notifications-toggle');
    notifToggle.addEventListener('ry:change', async (e) => {
      if (client.settings) {
        try {
          const currentTheme = document.documentElement.getAttribute('data-ry-theme') || 'light';
          const data = {
            theme: currentTheme,
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
