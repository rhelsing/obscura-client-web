/**
 * Bottom Navigation Component
 * 3-item nav: Pix | Chats | Stories + More drawer
 */

export function renderNav(active = 'pix') {
  return `
    <nav class="bottom-nav">
      <a href="/pix" data-navigo class="${active === 'pix' ? 'active' : ''}">
        <ry-icon name="star"></ry-icon>
        <span class="label">Pix</span>
      </a>
      <a href="/chats" data-navigo class="${active === 'chats' ? 'active' : ''}">
        <ry-icon name="edit"></ry-icon>
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
