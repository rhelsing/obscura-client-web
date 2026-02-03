/**
 * Bottom Navigation Component
 * 3-item nav: Pix | Chats | Stories + More drawer
 */

export function renderNav(active = 'pix', badges = {}) {
  const pixBadge = badges.pix ? `<span class="nav-badge">${badges.pix > 99 ? '99+' : badges.pix}</span>` : '';
  const chatsBadge = badges.chats ? `<span class="nav-badge">${badges.chats > 99 ? '99+' : badges.chats}</span>` : '';

  return `
    <nav class="bottom-nav">
      <a href="/pix" data-navigo class="${active === 'pix' ? 'active' : ''}" style="position: relative;">
        <ry-icon name="star"></ry-icon>
        ${pixBadge}
        <span class="label">Pix</span>
      </a>
      <a href="/chats" data-navigo class="${active === 'chats' ? 'active' : ''}" style="position: relative;">
        <ry-icon name="edit"></ry-icon>
        ${chatsBadge}
        <span class="label">Chats</span>
      </a>
      <a href="/stories" data-navigo class="${active === 'stories' ? 'active' : ''}">
        <ry-icon name="heart"></ry-icon>
        <span class="label">Stories</span>
      </a>
      <button drawer="more-drawer" class="${active === 'more' ? 'active' : ''}">
        <ry-icon name="menu"></ry-icon>
        <span class="label">More</span>
      </button>
    </nav>

    <ry-drawer id="more-drawer" side="bottom">
      <stack gap="md" style="padding: var(--ry-space-4)">
        <h3 style="margin: 0">Menu</h3>
        <divider></divider>
        <a href="/profile" data-navigo class="drawer-link">
          <ry-icon name="user"></ry-icon> Profile
        </a>
        <a href="/friends" data-navigo class="drawer-link">
          <ry-icon name="user"></ry-icon> Friends
        </a>
        <a href="/groups" data-navigo class="drawer-link">
          <ry-icon name="star"></ry-icon> Groups
        </a>
        <a href="/devices" data-navigo class="drawer-link">
          <ry-icon name="settings"></ry-icon> Devices
        </a>
        <a href="/logs" data-navigo class="drawer-link">
          <ry-icon name="info"></ry-icon> Logs
        </a>
        <a href="/settings" data-navigo class="drawer-link">
          <ry-icon name="settings"></ry-icon> Settings
        </a>
        <divider></divider>
        <button variant="danger" id="logout-btn">
          <ry-icon name="external-link"></ry-icon> Logout
        </button>
      </stack>
    </ry-drawer>
  `;
}

/**
 * Initialize nav event handlers
 * @param {HTMLElement} container
 * @param {Function} onLogout - Logout callback
 */
export function initNav(container, onLogout) {
  const drawer = container.querySelector('#more-drawer');
  const logoutBtn = container.querySelector('#logout-btn');

  // Close drawer when any link inside it is clicked
  if (drawer) {
    drawer.querySelectorAll('a[data-navigo]').forEach(link => {
      link.addEventListener('click', () => {
        if (drawer.close) drawer.close();
      });
    });
  }

  if (logoutBtn && onLogout) {
    logoutBtn.addEventListener('click', () => {
      if (drawer?.close) drawer.close();
      onLogout();
    });
  }
}

/**
 * Update pix badge count
 * @param {number} count - Number of unviewed pix
 */
export function updatePixBadge(count) {
  const pixLink = document.querySelector('.bottom-nav a[href="/pix"]');
  if (!pixLink) return;

  // Remove existing badge
  const existingBadge = pixLink.querySelector('.nav-badge');
  if (existingBadge) existingBadge.remove();

  // Add new badge if count > 0
  if (count > 0) {
    const badge = document.createElement('span');
    badge.className = 'nav-badge';
    badge.textContent = count > 99 ? '99+' : count;
    pixLink.insertBefore(badge, pixLink.querySelector('.label'));
  }
}

/**
 * Update chats badge count
 * @param {number} count - Number of unread conversations
 */
export function updateChatsBadge(count) {
  const chatsLink = document.querySelector('.bottom-nav a[href="/chats"]');
  if (!chatsLink) return;

  // Remove existing badge
  const existingBadge = chatsLink.querySelector('.nav-badge');
  if (existingBadge) existingBadge.remove();

  // Add new badge if count > 0
  if (count > 0) {
    const badge = document.createElement('span');
    badge.className = 'nav-badge';
    badge.textContent = count > 99 ? '99+' : count;
    chatsLink.insertBefore(badge, chatsLink.querySelector('.label'));
  }
}
