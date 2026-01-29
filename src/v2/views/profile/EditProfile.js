/**
 * EditProfile View
 * - Edit displayName, bio, avatarUrl
 */
import { navigate } from '../index.js';

let cleanup = null;

export function render({ profile = null, loading = false, saving = false, error = null, username = '' } = {}) {
  if (loading) {
    return `<div class="view edit-profile"><div class="loading">Loading...</div></div>`;
  }

  return `
    <div class="view edit-profile">
      <header>
        <a href="/profile" data-navigo class="back">← Cancel</a>
        <h1>Edit Profile</h1>
      </header>

      ${error ? `<div class="error">${error}</div>` : ''}

      <form id="profile-form">
        <div class="avatar-section">
          ${profile?.data?.avatarUrl ? `
            <img class="avatar-preview" src="${profile.data.avatarUrl}" alt="Avatar" />
          ` : `
            <div class="avatar-placeholder">?</div>
          `}
          <button type="button" id="change-avatar-btn" class="secondary" ${saving ? 'disabled' : ''}>
            Change Photo
          </button>
        </div>

        <label>
          Display Name
          <input
            type="text"
            id="display-name"
            value="${profile?.data?.displayName || ''}"
            placeholder="${username || 'Your name'}"
            ${saving ? 'disabled' : ''}
          />
        </label>

        <label>
          Bio
          <textarea
            id="bio"
            rows="3"
            placeholder="Tell us about yourself..."
            ${saving ? 'disabled' : ''}
          >${profile?.data?.bio || ''}</textarea>
        </label>

        <button type="submit" class="primary" ${saving ? 'disabled' : ''}>
          ${saving ? 'Saving...' : 'Save Changes'}
        </button>
      </form>

      <input type="file" id="avatar-input" accept="image/*" hidden />
    </div>
  `;
}

export async function mount(container, client, router) {
  container.innerHTML = render({ loading: true });

  let profile = null;
  let profileId = null;

  try {
    if (client.profile) {
      profile = await client.profile.where({
        authorDeviceId: client.deviceUUID
      }).first();

      if (profile) {
        profileId = profile.id;
      }
    }

    container.innerHTML = render({ profile, username: client.username });

    const form = container.querySelector('#profile-form');
    const avatarBtn = container.querySelector('#change-avatar-btn');
    const avatarInput = container.querySelector('#avatar-input');

    let avatarUrl = profile?.data?.avatarUrl || null;

    // Avatar change
    avatarBtn.addEventListener('click', () => {
      avatarInput.click();
    });

    avatarInput.addEventListener('change', () => {
      const file = avatarInput.files[0];
      if (file) {
        // TODO: Upload and get URL
        // For now just show that a file was selected
        alert('Avatar upload not yet implemented');
      }
    });

    // Form submit
    form.addEventListener('submit', async (e) => {
      e.preventDefault();

      const displayName = container.querySelector('#display-name').value.trim();
      const bio = container.querySelector('#bio').value.trim();

      if (!displayName) {
        container.innerHTML = render({ profile, error: 'Display name is required' });
        mount(container, client, router);
        return;
      }

      container.innerHTML = render({ profile, saving: true });

      try {
        if (!client.profile) {
          throw new Error('Profile model not defined');
        }

        if (profileId) {
          await client.profile.upsert(profileId, {
            displayName,
            bio: bio || undefined,
            avatarUrl: avatarUrl || undefined
          });
        } else {
          await client.profile.create({
            displayName,
            bio: bio || undefined,
            avatarUrl: avatarUrl || undefined
          });
        }

        navigate('/profile');

      } catch (err) {
        container.innerHTML = render({ profile, error: err.message });
        mount(container, client, router);
      }
    });

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
