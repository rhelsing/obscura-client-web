/**
 * GroupList View
 * - List all groups
 * - Create new group button
 */
import { navigate } from '../index.js';

let cleanup = null;

export function render({ groups = [], loading = false } = {}) {
  if (loading) {
    return `<div class="view group-list"><div class="loading">Loading groups...</div></div>`;
  }

  return `
    <div class="view group-list">
      <header>
        <a href="/messages" data-navigo class="back">← Back</a>
        <h1>Groups</h1>
      </header>

      ${groups.length === 0 ? `
        <div class="empty">
          <p>No groups yet</p>
          <a href="/groups/new" data-navigo class="button">Create a Group</a>
        </div>
      ` : `
        <ul class="group-items">
          ${groups.map(g => `
            <li class="group-item" data-id="${g.id}">
              <div class="group-info">
                <span class="group-name">${escapeHtml(g.data.name)}</span>
                <span class="member-count">${getMemberCount(g.data.members)} members</span>
              </div>
              <span class="arrow">→</span>
            </li>
          `).join('')}
        </ul>
      `}

      <a href="/groups/new" data-navigo class="fab">+</a>
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
