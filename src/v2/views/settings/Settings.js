/**
 * Settings View
 * - Theme toggle
 * - Notifications toggle
 * - Link to devices
 * - Logout
 */
import { navigate, clearClient } from '../index.js';

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

      <section class="settings-group">
        <h2>Appearance</h2>
        <label class="setting-row">
          <span>Dark Mode</span>
          <input
            type="checkbox"
            id="theme-toggle"
            ${theme === 'dark' ? 'checked' : ''}
            ${saving ? 'disabled' : ''}
          />
        </label>
      </section>

      <section class="settings-group">
        <h2>Notifications</h2>
        <label class="setting-row">
          <span>Enable Notifications</span>
          <input
            type="checkbox"
            id="notifications-toggle"
            ${notifications ? 'checked' : ''}
            ${saving ? 'disabled' : ''}
          />
        </label>
      </section>

      <section class="settings-group">
        <h2>Devices</h2>
        <a href="/devices" data-navigo class="setting-link">
          Manage Devices →
        </a>
        <a href="/link-device" data-navigo class="setting-link">
          Link New Device →
        </a>
      </section>

      <section class="settings-group">
        <h2>Profile</h2>
        <a href="/profile" data-navigo class="setting-link">
          View Profile →
        </a>
        <a href="/profile/edit" data-navigo class="setting-link">
          Edit Profile →
        </a>
      </section>

      <section class="settings-group danger">
        <h2>Account</h2>
        <button id="logout-btn" class="danger">Log Out</button>
      </section>

      <nav class="bottom-nav">
        <a href="/stories" data-navigo>Feed</a>
        <a href="/messages" data-navigo>Messages</a>
        <a href="/friends" data-navigo>Friends</a>
        <a href="/settings" data-navigo class="active">Settings</a>
      </nav>
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

    // Theme toggle
    const themeToggle = container.querySelector('#theme-toggle');
    themeToggle.addEventListener('change', async () => {
      const newTheme = themeToggle.checked ? 'dark' : 'light';

      // Apply immediately
      document.body.classList.toggle('dark', newTheme === 'dark');

      // Save
      if (client.settings) {
        try {
          const data = {
            theme: newTheme,
            notificationsEnabled: container.querySelector('#notifications-toggle').checked
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

    // Notifications toggle
    const notifToggle = container.querySelector('#notifications-toggle');
    notifToggle.addEventListener('change', async () => {
      if (client.settings) {
        try {
          const data = {
            theme: container.querySelector('#theme-toggle').checked ? 'dark' : 'light',
            notificationsEnabled: notifToggle.checked
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

    // Logout
    const logoutBtn = container.querySelector('#logout-btn');
    logoutBtn.addEventListener('click', () => {
      if (confirm('Are you sure you want to log out?')) {
        client.disconnect();
        clearClient();
      }
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
