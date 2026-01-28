# ry-ui Migration Plan for Obscura v2

## Overview

Migrate the v2 web client from custom CSS/components to [ry-ui](../ry-ui), a framework-agnostic Light DOM component library. This will provide consistent theming, accessibility, and reduce custom CSS.

## Setup

### 1. Link ry-ui in index.html

```html
<html lang="en" data-ry-theme="light">
<head>
  <link rel="stylesheet" href="/path/to/ry-ui/dist/ry-ui.css">
  <link rel="stylesheet" href="/path/to/ry-ui/src/themes/light.css">
  <link rel="stylesheet" href="/path/to/ry-ui/src/themes/dark.css">
</head>
<body>
  <ry-page>
    <div id="app"></div>
  </ry-page>
  <script type="module" src="/path/to/ry-ui/dist/ry-ui.js"></script>
</body>
</html>
```

### 2. Theme Switching

ry-ui uses `data-ry-theme="light|dark"` on the `<html>` element.

**Replace custom dark mode toggle with:**
```html
<ry-theme-toggle themes="light,dark"></ry-theme-toggle>
```

**Or programmatically:**
```javascript
document.documentElement.setAttribute('data-ry-theme', 'dark');
```

**In Settings.js**, remove the custom theme toggle and use:
```javascript
// Save preference
localStorage.setItem('ry-theme', theme);

// On page load (in main.js)
const savedTheme = localStorage.getItem('ry-theme') || 'light';
document.documentElement.setAttribute('data-ry-theme', savedTheme);
```

---

## Component Migration Map

### Page Layout

**Before:**
```html
<div class="view story-feed">
  <header><h1>Feed</h1></header>
  <!-- content -->
  <nav class="bottom-nav">...</nav>
</div>
```

**After:**
```html
<ry-page>
  <ry-header sticky>
    <h1>Feed</h1>
  </ry-header>
  <ry-main>
    <!-- content -->
  </ry-main>
  <!-- bottom nav stays custom or use drawer -->
</ry-page>
```

---

### Bottom Navigation → Drawer

**Replace the custom "More" slide-up menu with ry-ui drawer:**

```html
<nav class="bottom-nav">
  <a href="/stories"><icon name="heart"></icon> Feed</a>
  <a href="/messages"><icon name="chat"></icon> Messages</a>
  <a href="/friends"><icon name="user"></icon> Friends</a>
  <a href="/groups"><icon name="users"></icon> Groups</a>
  <button drawer="more-drawer"><icon name="menu"></icon> More</button>
</nav>

<drawer id="more-drawer" side="bottom">
  <stack gap="sm">
    <a href="/profile" data-navigo>
      <icon name="user"></icon> Profile
    </a>
    <a href="/devices" data-navigo>
      <icon name="settings"></icon> Devices
    </a>
    <a href="/logs" data-navigo>
      <icon name="info"></icon> Logs
    </a>
    <a href="/settings" data-navigo>
      <icon name="settings"></icon> Settings
    </a>
    <divider></divider>
    <button variant="danger" id="logout-btn">
      <icon name="external-link"></icon> Logout
    </button>
  </stack>
</drawer>
```

---

### Cards

**Stories, Messages, Friends lists → use `<card>`:**

```html
<!-- Story Card -->
<card>
  <cluster>
    <strong>alice</strong>
    <span style="color: var(--ry-color-text-muted)">2h ago</span>
  </cluster>
  <p>Story content here...</p>
  <actions>
    <button variant="ghost" size="sm">❤️ 5</button>
    <button variant="ghost" size="sm">💬 3</button>
  </actions>
</card>

<!-- Friend Item -->
<card>
  <cluster>
    <icon name="user"></icon>
    <stack gap="none">
      <strong>bob</strong>
      <badge variant="success">accepted</badge>
    </stack>
    <icon name="chevron-right"></icon>
  </cluster>
</card>
```

---

### Forms

**Use `<field>` wrapper for form inputs:**

```html
<stack gap="md">
  <field label="Username">
    <input type="text" placeholder="Enter username" required>
  </field>
  <field label="Password">
    <input type="password" placeholder="Enter password" required>
  </field>
  <button type="submit">Login</button>
</stack>
```

---

### Settings Toggles

**Replace checkbox toggles with `<switch>`:**

```html
<stack gap="sm">
  <switch name="darkMode" id="dark-mode-toggle">Dark Mode</switch>
  <switch name="notifications" checked>Enable Notifications</switch>
</stack>
```

```javascript
const darkToggle = document.querySelector('#dark-mode-toggle');
darkToggle.addEventListener('ry:change', (e) => {
  const theme = e.detail.checked ? 'dark' : 'light';
  document.documentElement.setAttribute('data-ry-theme', theme);
  localStorage.setItem('ry-theme', theme);
});
```

---

### Modals for Confirmations

**Logout, Delete, Revoke actions:**

```html
<button modal="logout-modal" variant="danger">Logout</button>

<modal id="logout-modal" title="Confirm Logout">
  <p>Are you sure you want to log out?</p>
  <actions slot="footer">
    <button variant="ghost" close>Cancel</button>
    <button variant="danger" id="confirm-logout">Logout</button>
  </actions>
</modal>
```

```javascript
document.querySelector('#confirm-logout').addEventListener('click', () => {
  client.disconnect();
  ObscuraClient.clearSession();
  clearClient();
  navigate('/login');
});
```

---

### Badges for Status

```html
<badge variant="success">accepted</badge>
<badge variant="warning">pending</badge>
<badge variant="danger">rejected</badge>
<badge variant="primary">3 new</badge>
```

---

### Alerts for Errors/Warnings

```html
<alert type="danger" title="Error">
  Failed to connect to server. Please try again.
</alert>

<alert type="warning" title="Recovery Phrase">
  Write these words down and keep them safe!
</alert>

<alert type="info">
  Stories disappear after 24 hours.
</alert>
```

---

### Icons (Replace Emojis)

**Available icons:** close, check, chevron-*, copy, sun, moon, info, warning, error, success, search, menu, plus, minus, settings, user, heart, star, trash, edit, external-link, download, upload

```html
<!-- Nav -->
<icon name="heart"></icon> Feed
<icon name="chat"></icon> Messages
<icon name="user"></icon> Friends
<icon name="menu"></icon> More

<!-- Actions -->
<icon name="plus"></icon> Add
<icon name="trash"></icon> Delete
<icon name="edit"></icon> Edit
<icon name="settings"></icon> Settings
```

---

### Tabs for Logs Filters

```html
<tabs>
  <tab title="All" active>
    <!-- all events -->
  </tab>
  <tab title="Send">
    <!-- send events -->
  </tab>
  <tab title="Receive">
    <!-- receive events -->
  </tab>
  <tab title="Session">
    <!-- session events -->
  </tab>
</tabs>
```

---

### Dropdowns for Actions

```html
<dropdown>
  <button slot="trigger" variant="ghost">
    <icon name="menu"></icon>
  </button>
  <menu>
    <menu-item>Reply</menu-item>
    <menu-item>React</menu-item>
    <divider></divider>
    <menu-item>Delete</menu-item>
  </menu>
</dropdown>
```

---

### Toasts (Already Using!)

```javascript
RyToast.success('Message sent!');
RyToast.error('Connection failed');
RyToast.warning('Low prekey count');
RyToast.info('New message from alice');
```

---

## Files to Modify

### Priority 1: Foundation
1. `index.html` - Add ry-ui CSS/JS, wrap in `<ry-page>`
2. `main.js` - Initialize theme from localStorage
3. `src/v2/styles.css` - Remove redundant styles (keep only app-specific)

### Priority 2: Navigation
4. `views/components/Nav.js` - Use `<drawer>` for More menu, `<icon>` for nav items

### Priority 3: Views (in order of usage)
5. `views/auth/Login.js` - Use `<field>`, `<button>`, `<alert>`
6. `views/auth/Register.js` - Use `<field>`, `<button>`, `<alert>`
7. `views/stories/StoryFeed.js` - Use `<card>`, `<stack>`
8. `views/messaging/ConversationList.js` - Use `<card>`, `<badge>`
9. `views/friends/FriendList.js` - Use `<card>`, `<badge>`
10. `views/settings/Settings.js` - Use `<switch>`, `<ry-theme-toggle>`
11. `views/logs/Logs.js` - Use `<tabs>`, `<card>`

### Priority 4: Secondary Views
12. `views/stories/CreateStory.js`
13. `views/stories/StoryDetail.js`
14. `views/messaging/Chat.js`
15. `views/friends/AddFriend.js`
16. `views/friends/FriendRequests.js`
17. `views/devices/DeviceList.js`
18. `views/groups/GroupList.js`
19. `views/profile/ViewProfile.js`

---

## Theme Integration

### Settings Model Update

The ORM `settings` model already has a `theme` field. Sync it with ry-ui:

```javascript
// On settings load
const settings = await client.settings.where({}).first();
if (settings?.data?.theme) {
  document.documentElement.setAttribute('data-ry-theme', settings.data.theme);
}

// On theme change
async function setTheme(theme) {
  document.documentElement.setAttribute('data-ry-theme', theme);
  await client.settings.upsert(settingsId, {
    theme,
    notificationsEnabled: currentNotifications
  });
}
```

This syncs theme across devices via the ORM's private model sync!

---

## CSS Variables

ry-ui exposes CSS variables you can use:

```css
/* Colors */
var(--ry-color-primary)
var(--ry-color-bg)
var(--ry-color-text)
var(--ry-color-text-muted)
var(--ry-color-border)
var(--ry-color-success)
var(--ry-color-warning)
var(--ry-color-danger)

/* Spacing */
var(--ry-space-1) /* 4px */
var(--ry-space-2) /* 8px */
var(--ry-space-3) /* 12px */
var(--ry-space-4) /* 16px */

/* Typography */
var(--ry-text-sm)
var(--ry-text-base)
var(--ry-text-lg)
var(--ry-text-xl)

/* Radius */
var(--ry-radius-sm)
var(--ry-radius-md)
var(--ry-radius-lg)
```

---

## Migration Checklist

- [ ] Add ry-ui to index.html
- [ ] Initialize theme on page load
- [ ] Replace More menu with `<drawer>`
- [ ] Replace nav emojis with `<icon>`
- [ ] Update Login/Register forms with `<field>`
- [ ] Replace confirm() with `<modal>`
- [ ] Replace settings checkboxes with `<switch>`
- [ ] Add `<ry-theme-toggle>` to settings
- [ ] Update story cards with `<card>`
- [ ] Update friend/message lists with `<card>` + `<badge>`
- [ ] Update logs with `<tabs>`
- [ ] Remove redundant CSS from styles.css
- [ ] Test dark mode persistence across sessions
- [ ] Test theme sync across devices (ORM)

---

## Notes

- ry-ui uses Light DOM, so components work with vanilla JS and Navigo router
- All ry-ui components emit `ry:*` events (e.g., `ry:change`, `ry:open`)
- The `close` attribute on buttons inside modals/drawers auto-closes them
- `data-navigo` links work inside ry-ui components
