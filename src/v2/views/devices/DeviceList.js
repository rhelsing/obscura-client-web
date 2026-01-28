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
        <a href="/settings" data-navigo class="back">← Back</a>
        <h1>Devices</h1>
      </header>

      <section class="current-device">
        <h2>This Device</h2>
        <div class="device-item current">
          <span class="device-id">${currentDeviceId.slice(0, 8)}...</span>
          <span class="badge">Current</span>
        </div>
      </section>

      <section class="other-devices">
        <h2>Other Devices</h2>
        ${devices.length === 0 ? `
          <p class="empty">No other devices linked</p>
        ` : `
          <ul class="device-items">
            ${devices.map(d => `
              <li class="device-item">
                <span class="device-id">${d.deviceUUID.slice(0, 8)}...</span>
                <button class="revoke-btn danger" data-device-id="${d.deviceUUID}">Revoke</button>
              </li>
            `).join('')}
          </ul>
        `}
      </section>

      <section class="actions">
        <a href="/link-device" data-navigo class="button primary">Link New Device</a>
      </section>

      <p class="hint">
        To revoke a device, you'll need your 12-word recovery phrase.
      </p>
    </div>
  `;
}

export async function mount(container, client, router) {
  container.innerHTML = render({ loading: true });

  // Get devices - this would come from local storage or sync
  // For now, we only know about our own device
  const devices = []; // TODO: Track linked devices

  container.innerHTML = render({
    devices,
    currentDeviceId: client.deviceUUID
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
