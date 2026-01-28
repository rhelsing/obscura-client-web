/**
 * ViewProfile View
 * - Display user profile
 * - Edit button for own profile
 */
import { navigate } from '../index.js';

let cleanup = null;

export function render({ profile = null, isOwn = false, loading = false, username = '' } = {}) {
  if (loading) {
    return `<div class="view profile"><div class="loading">Loading profile...</div></div>`;
  }

  return `
    <div class="view profile">
      <header>
        <a href="/friends" data-navigo class="back"><ry-icon name="chevron-left"></ry-icon> Back</a>
        <h1>${isOwn ? 'My Profile' : username}</h1>
        ${isOwn ? `<a href="/profile/edit" data-navigo><button variant="ghost" size="sm"><ry-icon name="edit"></ry-icon> Edit</button></a>` : ''}
      </header>

      <card>
        <stack gap="md" style="text-align: center; padding: var(--ry-space-4)">
          ${profile?.data?.avatarUrl ? `
            <img class="avatar" src="${profile.data.avatarUrl}" alt="Avatar" style="width: 120px; height: 120px; border-radius: 50%; object-fit: cover; margin: 0 auto" />
          ` : `
            <div style="width: 120px; height: 120px; border-radius: 50%; background: var(--ry-color-bg-secondary); display: flex; align-items: center; justify-content: center; font-size: 48px; font-weight: bold; margin: 0 auto; color: var(--ry-color-text-muted)">${(username || 'U')[0].toUpperCase()}</div>
          `}

          <h2 style="margin: 0">${profile?.data?.displayName || username || 'Unknown'}</h2>

          ${profile?.data?.bio ? `
            <p style="color: var(--ry-color-text-muted)">${escapeHtml(profile.data.bio)}</p>
          ` : `
            <p style="color: var(--ry-color-text-muted); font-style: italic">No bio yet</p>
          `}
        </stack>
      </card>

      ${!isOwn ? `
        <div style="margin-top: var(--ry-space-4)">
          <a href="/messages/${username}" data-navigo><button><ry-icon name="edit"></ry-icon> Send Message</button></a>
        </div>
      ` : ''}
    </div>
  `;
}

function escapeHtml(text) {
  if (!text) return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

export async function mount(container, client, router, params) {
  const username = params.username || client.username;
  const isOwn = !params.username || params.username === client.username;

  container.innerHTML = render({ loading: true, username });

  try {
    let profile = null;

    if (client.profile) {
      if (isOwn) {
        // Get own profile
        profile = await client.profile.where({
          authorDeviceId: client.deviceUUID
        }).first();
      } else {
        // Get friend's profile - would need to query by username or userId
        // For now, show placeholder
        profile = null;
      }
    }

    container.innerHTML = render({ profile, isOwn, username });
    router.updatePageLinks();

  } catch (err) {
    container.innerHTML = `<div class="error">Failed to load profile: ${err.message}</div>`;
  }

  cleanup = () => {};
}

export function unmount() {
  if (cleanup) {
    cleanup();
    cleanup = null;
  }
}
