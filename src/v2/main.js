/**
 * V2 App Entry Point
 */
import { init, setClient } from './views/index.js';
import { ObscuraClient } from './lib/ObscuraClient.js';
import { fullSchema } from './lib/schema.js';

// Auto-reload on stale chunk errors (happens after deploys when cached HTML references old hashes)
window.addEventListener('vite:preloadError', () => {
  window.location.reload();
});
window.addEventListener('unhandledrejection', (e) => {
  if (e.reason?.message?.includes('dynamically imported module')) {
    window.location.reload();
  }
});

async function bootstrap() {
  // Initialize theme from localStorage
  const savedTheme = localStorage.getItem('ry-theme') || 'light';
  document.documentElement.setAttribute('data-ry-theme', savedTheme);

  const app = document.getElementById('app');

  if (!app) {
    console.error('App container not found');
    return;
  }

  // Try to restore session (may refresh expired token)
  const client = await ObscuraClient.restoreSession();

  if (client) {
    console.log('[main] Restored session for:', client.username);

    try {
      // Initialize schema
      await client.schema(fullSchema);
      console.log('[main] Schema initialized');

      // Connect to WebSocket
      await client.connect();
      console.log('[main] Connected to gateway');

      // Initialize app with restored client
      init(app, client);
    } catch (e) {
      console.warn('[main] Failed to restore connection:', e.message);
      // Clear bad session and start fresh
      ObscuraClient.clearSession();
      init(app, null);
    }
  } else {
    // No saved session, start fresh
    init(app, null);
  }
}

bootstrap();

// Expose helpers in dev mode
if (import.meta.env.DEV) {
  import('./lib/index.js').then(m => {
    window.Obscura = m.Obscura;
  });
}
