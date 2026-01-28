/**
 * V2 App Entry Point
 */
import { init } from './views/index.js';

// Initialize the app
const app = document.getElementById('app');

if (!app) {
  console.error('App container not found');
} else {
  init(app);
}

// Expose helpers in dev mode
if (import.meta.env.DEV) {
  import('./lib/index.js').then(m => {
    window.Obscura = m.Obscura;
  });
}
