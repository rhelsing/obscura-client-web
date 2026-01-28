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
        <a href="/friends" data-navigo class="back">← Back</a>
        <h1>${isOwn ? 'My Profile' : username}</h1>
        ${isOwn ? `<a href="/profile/edit" data-navigo class="edit-link">Edit</a>` : ''}
      </header>

      <div class="profile-content">
        ${profile?.data?.avatarUrl ? `
          <img class="avatar" src="${profile.data.avatarUrl}" alt="Avatar" />
        ` : `
          <div class="avatar-placeholder">${(username || 'U')[0].toUpperCase()}</div>
        `}

        <h2 class="display-name">${profile?.data?.displayName || username || 'Unknown'}</h2>

        ${profile?.data?.bio ? `
          <p class="bio">${escapeHtml(profile.data.bio)}</p>
        ` : `
          <p class="bio empty">No bio yet</p>
        `}
      </div>

      ${!isOwn ? `
        <div class="profile-actions">
          <a href="/messages/${username}" data-navigo class="button">Send Message</a>
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
