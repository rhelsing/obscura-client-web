/**
 * DeviceList View
 * - Show linked devices
 * - Revoke button
 * - Link new device button
 */
import { navigate } from '../index.js';

let cleanup = null;

export function render({ devices = [], currentDeviceId = '', loading = false } = {}) {
  if (loading) {
    return `<div class="view device-list"><div class="loading">Loading...</div></div>`;
  }

  return `
    <div class="view device-list">
      <header>
        <a href="/settings" data-navigo class="back"><ry-icon name="chevron-left"></ry-icon> Back</a>
        <h1>Devices</h1>
      </header>

      <stack gap="lg">
        <section>
          <h2>This Device</h2>
          <card style="border: 2px solid var(--ry-color-primary)">
            <cluster>
              <ry-icon name="settings"></ry-icon>
              <span style="font-family: monospace; flex: 1">${currentDeviceId.slice(0, 8)}...</span>
              <badge variant="primary">Current</badge>
            </cluster>
          </card>
        </section>

        <section>
          <h2>Other Devices</h2>
          ${devices.length === 0 ? `
            <p style="color: var(--ry-color-text-muted)">No other devices linked</p>
          ` : `
            <stack gap="sm" class="device-items">
              ${devices.map(d => `
                <card>
                  <cluster>
                    <ry-icon name="settings"></ry-icon>
                    <span style="font-family: monospace; flex: 1">${d.deviceUUID.slice(0, 8)}...</span>
                    <button size="sm" class="sync-btn" data-server-id="${d.serverUserId}" style="display: none;">Push History</button>
                    <button variant="danger" size="sm" class="revoke-btn" data-device-id="${d.deviceUUID}">Revoke</button>
                  </cluster>
                </card>
              `).join('')}
            </stack>
          `}
        </section>

        <section>
          <a href="/link-device" data-navigo><button><ry-icon name="plus"></ry-icon> Link New Device</button></a>
        </section>
      </stack>

      <ry-alert type="info" style="margin-top: var(--ry-space-4)">
        To revoke a device, you'll need your 12-word recovery phrase.
      </ry-alert>
    </div>
  `;
}

export async function mount(container, client, router) {
  container.innerHTML = render({ loading: true });

  // Get devices from DeviceManager (our own devices, excluding current)
  let devices = [];
  if (client.devices) {
    // DeviceManager stores in ownDevices, getAll() returns copy excluding current
    devices = client.devices.getAll();
  }

  container.innerHTML = render({
    devices,
    currentDeviceId: client.deviceUUID
  });

  // Push History buttons
  container.querySelectorAll('.sync-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const serverId = btn.dataset.serverId;
      btn.disabled = true;
      btn.textContent = 'Pushing...';
      try {
        await client.pushHistoryToDevice(serverId);
        btn.textContent = 'Done!';
        setTimeout(() => {
          btn.textContent = 'Push History';
          btn.disabled = false;
        }, 2000);
      } catch (e) {
        console.error('Failed to push history:', e);
        btn.textContent = 'Failed';
        setTimeout(() => {
          btn.textContent = 'Push History';
          btn.disabled = false;
        }, 2000);
      }
    });
  });

  // Revoke buttons
  container.querySelectorAll('.revoke-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const deviceId = btn.dataset.deviceId;
      navigate(`/devices/revoke/${deviceId}`);
    });
  });

  router.updatePageLinks();

  cleanup = () => {};
}

export function unmount() {
  if (cleanup) {
    cleanup();
    cleanup = null;
  }
}
