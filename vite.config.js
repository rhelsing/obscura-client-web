import { defineConfig, loadEnv } from 'vite';
import { resolve } from 'path';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const apiUrl = env.VITE_API_URL;
  const wsUrl = apiUrl?.replace('https://', 'wss://');

  return {
    base: mode === 'production' ? '/obscura-client-web/' : '/',
    server: {
      port: 5173,
      proxy: {
        '/api': {
          target: apiUrl,
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api/, ''),
          secure: true,
        },
        '/ws': {
          target: wsUrl,
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/ws/, ''),
          ws: true,
          secure: true,
        },
      },
    },
    build: {
      outDir: 'dist',
      rollupOptions: {
        input: {
          main: resolve(__dirname, 'index.html'),
          v2: resolve(__dirname, 'v2.html'),
        },
      },
    },
  };
});
