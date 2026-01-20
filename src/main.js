import Navigo from 'navigo';
import { renderLanding } from './pages/landing.js';
import { renderApp } from './pages/app.js';

const app = document.getElementById('app');
const base = import.meta.env.BASE_URL || '/';
const router = new Navigo(base);

// Track which stylesheet is loaded
let currentStyle = null;

function loadStylesheet(href) {
  // Remove old mobile/main stylesheet if switching
  if (currentStyle) {
    currentStyle.remove();
  }

  // Remove the default main.css from index.html on first load
  const defaultStyle = document.querySelector('link[href="/src/styles/main.css"]');
  if (defaultStyle && href !== '/src/styles/main.css') {
    defaultStyle.remove();
  }

  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = href;
  document.head.appendChild(link);
  currentStyle = link;
}

router
  .on('/', () => {
    loadStylesheet('/src/styles/mobile.css');
    renderApp(app);
  })
  .on('/testing', () => {
    loadStylesheet('/src/styles/main.css');
    renderLanding(app, router);
  })
  .resolve();
