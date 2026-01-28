/**
 * CreateGroup View
 * - Name input
 * - Member picker (from friends)
 */
import { navigate } from '../index.js';

let cleanup = null;

export function render({ friends = [], selectedMembers = [], name = '', error = null, loading = false } = {}) {
  return `
    <div class="view create-group">
      <header>
        <a href="/groups" data-navigo class="back">← Cancel</a>
        <h1>New Group</h1>
      </header>

      ${error ? `<div class="error">${error}</div>` : ''}

      <form id="group-form">
        <label>
          Group Name
          <input
            type="text"
            id="group-name"
            value="${name}"
            placeholder="Enter group name"
            required
            ${loading ? 'disabled' : ''}
          />
        </label>

        <div class="member-section">
          <h2>Add Members</h2>
          ${friends.length === 0 ? `
            <p class="empty">No friends to add</p>
          ` : `
            <ul class="friend-picker">
              ${friends.map(f => `
                <li class="friend-option">
                  <label>
                    <input
                      type="checkbox"
                      value="${f.username}"
                      ${selectedMembers.includes(f.username) ? 'checked' : ''}
                      ${loading ? 'disabled' : ''}
                    />
                    ${f.username}
                  </label>
                </li>
              `).join('')}
            </ul>
          `}
        </div>

        <div class="selected-count">
          ${selectedMembers.length} member${selectedMembers.length !== 1 ? 's' : ''} selected
        </div>

        <button type="submit" class="primary" ${loading ? 'disabled' : ''}>
          ${loading ? 'Creating...' : 'Create Group'}
        </button>
      </form>
    </div>
  `;
}

export function mount(container, client, router) {
  // Get friends list
  const friends = [];
  if (client.friends) {
    for (const [username, data] of client.friends) {
      if (data.status === 'accepted') {
        friends.push({ username });
      }
    }
  }

  let selectedMembers = [client.username]; // Always include self

  container.innerHTML = render({ friends, selectedMembers });

  const form = container.querySelector('#group-form');

  // Track checkbox changes
  const updateSelection = () => {
    const checkboxes = container.querySelectorAll('.friend-picker input[type="checkbox"]');
    selectedMembers = [client.username]; // Always include self
    checkboxes.forEach(cb => {
      if (cb.checked && !selectedMembers.includes(cb.value)) {
        selectedMembers.push(cb.value);
      }
    });

    // Update count display
    const countEl = container.querySelector('.selected-count');
    if (countEl) {
      countEl.textContent = `${selectedMembers.length} member${selectedMembers.length !== 1 ? 's' : ''} selected`;
    }
  };

  container.querySelectorAll('.friend-picker input').forEach(cb => {
    cb.addEventListener('change', updateSelection);
  });

  // Form submit
  form.addEventListener('submit', async (e) => {
    e.preventDefault();

    const name = container.querySelector('#group-name').value.trim();

    if (!name) {
      container.innerHTML = render({ friends, selectedMembers, error: 'Please enter a group name' });
      mount(container, client, router);
      return;
    }

    if (selectedMembers.length < 2) {
      container.innerHTML = render({ friends, selectedMembers, name, error: 'Please select at least one member' });
      mount(container, client, router);
      return;
    }

    container.innerHTML = render({ friends, selectedMembers, name, loading: true });

    try {
      if (!client.group) {
        throw new Error('Group model not defined');
      }

      await client.group.create({
        name,
        members: JSON.stringify(selectedMembers)
      });

      navigate('/groups');

    } catch (err) {
      container.innerHTML = render({ friends, selectedMembers, name, error: err.message });
      mount(container, client, router);
    }
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
