import Navigo from 'navigo';
import { renderLanding } from './pages/landing.js';
import { renderApp } from './pages/app.js';

const app = document.getElementById('app');
const base = import.meta.env.BASE_URL || '/';
const router = new Navigo(base);

function loadStylesheet(href) {
  const stylesheet = document.getElementById('main-stylesheet');
  if (stylesheet) {
    stylesheet.href = href;
  }
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
