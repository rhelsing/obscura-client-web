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
    loadStylesheet(`${base}src/styles/main.css`);
    renderLanding(app, router);
  })
  .resolve();
