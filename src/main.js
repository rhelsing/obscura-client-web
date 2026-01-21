import Navigo from 'navigo';
import { renderLanding } from './pages/landing.js';
import { renderApp } from './pages/app.js';

const app = document.getElementById('app');
const base = import.meta.env.BASE_URL || '/';
const router = new Navigo(base);

// Handle GitHub Pages SPA redirect (from 404.html)
const params = new URLSearchParams(window.location.search);
const redirectPath = params.get('p');
if (redirectPath) {
  // Clean URL and navigate to the intended path
  window.history.replaceState(null, '', base + redirectPath.replace(/^\//, ''));
}

function loadStylesheet(href) {
  const stylesheet = document.getElementById('main-stylesheet');
  if (stylesheet) {
    stylesheet.href = href;
  }
}

router
  .on('/', () => {
    loadStylesheet(`${base}src/styles/mobile.css`);
    renderApp(app);
  })
  .on('/add/:userId', ({ data }) => {
    loadStylesheet(`${base}src/styles/mobile.css`);
    renderApp(app, { pendingFriendId: data.userId });
  })
  .on('/testing', () => {
    loadStylesheet(`${base}src/styles/mobile.css`);
    renderLanding(app, router);
  })
  .resolve();

// Expose test helpers in dev mode
if (import.meta.env.DEV) {
  import('./api/gateway.js').then(m => window.__gateway = m.default);
  import('./api/client.js').then(m => window.__client = m.default);
  import('./lib/sessionManager.js').then(m => window.__sessionManager = m.sessionManager);
}
