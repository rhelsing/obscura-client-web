# ry-ui Usage Guide

How the Obscura web client uses [ry-ui](https://www.npmjs.com/package/@ryanhelsing/ry-ui) and the rules for writing CSS and HTML that plays nicely with it.

## Loading

ry-ui is loaded from CDN in `index.html`, pinned to a specific version:

```html
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@ryanhelsing/ry-ui@1.0.15/dist/css/ry-ui.css">
<script type="module" src="https://cdn.jsdelivr.net/npm/@ryanhelsing/ry-ui@1.0.15/dist/ry-ui.js"></script>
```

## Theme vs Mode

ry-ui separates two concepts:

- **Theme** — visual skin (colors, typography). Options: `default`, `ocean`, `antigravity`, `none`
- **Mode** — light or dark. Options: `light`, `dark`, `auto` (follows OS via `prefers-color-scheme`)

Set theme via attribute:
```html
<html data-ry-theme="default">
```

Control mode via `color-scheme` on the root element:
```js
// Auto (follow OS preference)
document.documentElement.style.removeProperty('color-scheme');

// Force light
document.documentElement.style.colorScheme = 'light';

// Force dark
document.documentElement.style.colorScheme = 'dark';
```

All ry-ui color tokens use `light-dark()` internally, so they respond to `color-scheme` automatically. **Do not use `data-ry-mode` or `data-ry-theme="dark"` to control dark mode.**

## Color Tokens

Use these instead of hardcoded colors. They adapt to light/dark mode automatically.

| Token | Purpose |
|-------|---------|
| `--ry-color-bg` | Primary background |
| `--ry-color-bg-subtle` | Secondary background (96% bg, 4% text) |
| `--ry-color-bg-muted` | Tertiary background (92% bg, 8% text) |
| `--ry-color-text` | Primary text |
| `--ry-color-text-muted` | Secondary/muted text (60% text, 40% bg) |
| `--ry-color-primary` | Accent color |
| `--ry-color-primary-hover` | Accent hover state |
| `--ry-color-danger` | Error/destructive actions |
| `--ry-color-success` | Success states |
| `--ry-color-border` | Borders and dividers |

### Spacing, Radius, Shadow

| Token | Purpose |
|-------|---------|
| `--ry-radius-md` | Standard border radius |
| `--ry-shadow-md` | Standard box shadow |
| `--ry-space-1` through `--ry-space-8` | Spacing scale |

## CSS Rules: Scope Everything

ry-ui components (ry-modal, ry-switch, ry-field, etc.) have internal structure. Bare element selectors in app CSS will bleed into them and break things.

**Always scope app styles to `.view`:**

```css
/* WRONG — bleeds into ry-modal buttons, ry-switch internals */
button { background: blue; }
label { display: flex; }
form { gap: 16px; }

/* RIGHT — only affects app views */
.view button { background: blue; }
.view label { display: flex; }
.view form { gap: 16px; }
```

The `.view` class is on every view's root `<div>` rendered by the view modules.

## Dark-Mode-Safe Backgrounds

Don't hardcode light-mode background colors. Use `color-mix()` with ry-ui tokens:

```css
/* WRONG — white-ish pink that looks broken in dark mode */
.error { background: #ffebee; }

/* RIGHT — 12% danger mixed into whatever bg is (adapts to dark mode) */
.error { background: color-mix(in oklch, var(--ry-color-danger) 12%, var(--ry-color-bg)); }
```

## Components Used

| Component | Where Used |
|-----------|-----------|
| `<ry-page>` | Root layout wrapper (`index.html`) |
| `<ry-icon>` | Icons throughout all views |
| `<ry-field>` | Form field wrapper with label |
| `<ry-switch>` | Toggle switches (Settings) |
| `<ry-alert>` | Error/warning banners |
| `<ry-modal>` | Confirmation dialogs (logout, unlink, revoke) |
| `<ry-badge>` | Status badges (friend list, logs) |
| `<card>` | Card containers |
| `<stack>` | Vertical flex layout |
| `<cluster>` | Horizontal flex layout |

### ry-switch Events

`<ry-switch>` emits `ry:change` with `e.detail.value` as a **string** (`'true'` or `'false'`):

```js
toggle.addEventListener('ry:change', (e) => {
  const enabled = e.detail.value === 'true';
});
```

### ry-modal

Trigger a modal by adding `modal="modal-id"` to a button:

```html
<button modal="confirm-modal">Delete</button>
<ry-modal id="confirm-modal" title="Confirm">
  <p>Are you sure?</p>
  <button id="confirm-btn">Yes</button>
</ry-modal>
```

## What NOT To Do

1. **Don't define `:root` CSS variables that shadow ry-ui tokens.** ry-ui owns `--ry-color-*`. If you need app-specific variables, prefix them differently (e.g., `--app-*`).

2. **Don't use `[data-ry-theme="dark"]` selectors in app CSS.** Dark mode is handled by `color-scheme` and `light-dark()` inside ry-ui tokens. Your CSS just uses the tokens and it works.

3. **Don't use bare element selectors** (`button`, `label`, `input`, `form`). Always scope to `.view` or a specific class.

4. **Don't hardcode colors that only work in light mode.** Use tokens or `color-mix()`.
