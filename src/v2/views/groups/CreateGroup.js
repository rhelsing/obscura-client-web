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
        <a href="/groups" data-navigo class="back"><ry-icon name="chevron-left"></ry-icon> Cancel</a>
        <h1>New Group</h1>
      </header>

      ${error ? `<ry-alert type="danger">${error}</ry-alert>` : ''}

      <form id="group-form">
        <stack gap="md">
          <ry-field label="Group Name">
            <input
              type="text"
              id="group-name"
              value="${name}"
              placeholder="Enter group name"
              required
              ${loading ? 'disabled' : ''}
            />
          </ry-field>

          <div>
            <h2>Add Members</h2>
            ${friends.length === 0 ? `
              <p style="color: var(--ry-color-text-muted)">No friends to add</p>
            ` : `
              <stack gap="sm" class="friend-picker">
                ${friends.map(f => `
                  <card class="friend-option">
                    <label style="display: flex; align-items: center; gap: var(--ry-space-3); cursor: pointer">
                      <input
                        type="checkbox"
                        value="${f.username}"
                        ${selectedMembers.includes(f.username) ? 'checked' : ''}
                        ${loading ? 'disabled' : ''}
                      />
                      <ry-icon name="user"></ry-icon>
                      ${f.username}
                    </label>
                  </card>
                `).join('')}
              </stack>
            `}
          </div>

          <badge variant="primary" class="selected-count">
            ${selectedMembers.length} member${selectedMembers.length !== 1 ? 's' : ''} selected
          </badge>

          <button type="submit" ${loading ? 'disabled' : ''}>
            ${loading ? 'Creating...' : 'Create Group'}
          </button>
        </stack>
      </form>
    </div>
  `;
}

export function mount(container, client, router) {
  // Get friends list
  const friends = [];
  if (client.friends && client.friends.friends) {
    for (const [username, data] of client.friends.friends) {
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
