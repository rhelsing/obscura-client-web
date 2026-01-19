import Navigo from 'navigo';
import { renderLanding } from './pages/landing.js';

const app = document.getElementById('app');
const router = new Navigo('/');

router
  .on('/', () => {
    renderLanding(app, router);
  })
  .resolve();
