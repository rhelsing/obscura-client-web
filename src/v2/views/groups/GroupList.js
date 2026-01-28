/**
 * GroupList View
 * - List all groups
 * - Create new group button
 */
import { navigate, clearClient } from '../index.js';
import { renderNav, initNav } from '../components/Nav.js';
import { ObscuraClient } from '../../lib/ObscuraClient.js';

let cleanup = null;

export function render({ groups = [], loading = false } = {}) {
  if (loading) {
    return `<div class="view group-list"><div class="loading">Loading groups...</div></div>`;
  }

  return `
    <div class="view group-list">
      <header>
        <a href="/messages" data-navigo class="back"><ry-icon name="chevron-left"></ry-icon> Back</a>
        <h1>Groups</h1>
      </header>

      ${groups.length === 0 ? `
        <div class="empty">
          <p>No groups yet</p>
          <a href="/groups/new" data-navigo><button>Create a Group</button></a>
        </div>
      ` : `
        <stack gap="sm" class="group-items">
          ${groups.map(g => `
            <card class="group-item" data-id="${g.id}">
              <cluster>
                <ry-icon name="star"></ry-icon>
                <stack gap="none" style="flex: 1">
                  <strong>${escapeHtml(g.data.name)}</strong>
                  <span style="color: var(--ry-color-text-muted); font-size: var(--ry-text-sm)">${getMemberCount(g.data.members)} members</span>
                </stack>
                <ry-icon name="chevron-right"></ry-icon>
              </cluster>
            </card>
          `).join('')}
        </stack>
      `}

      <a href="/groups/new" data-navigo class="fab">+</a>

      ${renderNav('groups')}
    </div>
  `;
}

function escapeHtml(text) {
  if (!text) return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function getMemberCount(membersJson) {
  try {
    return JSON.parse(membersJson).length;
  } catch {
    return 0;
  }
}

export async function mount(container, client, router) {
  container.innerHTML = render({ loading: true });

  try {
    let groups = [];

    if (client.group) {
      groups = await client.group.where({}).exec();
    }

    container.innerHTML = render({ groups });

    // Click handlers
    container.querySelectorAll('.group-item').forEach(item => {
      item.addEventListener('click', () => {
        navigate(`/groups/${item.dataset.id}`);
      });
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
    container.innerHTML = `<div class="error">Failed to load groups: ${err.message}</div>`;
  }

  cleanup = () => {};
}

export function unmount() {
  if (cleanup) {
    cleanup();
    cleanup = null;
  }
}
