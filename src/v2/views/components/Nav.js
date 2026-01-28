/**
 * Bottom Navigation Component
 * 5-item nav: Feed | Messages | Friends | Groups | More
 * "More" opens a ry-ui drawer
 */

export function renderNav(active = 'feed') {
  return `
    <nav class="bottom-nav">
      <a href="/stories" data-navigo class="${active === 'feed' ? 'active' : ''}">
        <ry-icon name="heart"></ry-icon>
        <span class="label">Feed</span>
      </a>
      <a href="/messages" data-navigo class="${active === 'messages' ? 'active' : ''}">
        <ry-icon name="edit"></ry-icon>
        <span class="label">Messages</span>
      </a>
      <a href="/friends" data-navigo class="${active === 'friends' ? 'active' : ''}">
        <ry-icon name="user"></ry-icon>
        <span class="label">Friends</span>
      </a>
      <a href="/groups" data-navigo class="${active === 'groups' ? 'active' : ''}">
        <ry-icon name="star"></ry-icon>
        <span class="label">Groups</span>
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
