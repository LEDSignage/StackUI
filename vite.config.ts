import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const SERVER = process.env.STACK_UI_SERVER ?? 'http://localhost:8790';

export default defineConfig({
  root: 'web',
  plugins: [react()],
  resolve: {
    alias: { '@shared': fileURLToPath(new URL('./shared', import.meta.url)) },
  },
  build: { outDir: '../dist', emptyOutDir: true },
  server: {
    port: 5174,
    // Everything the browser needs from ComfyUI goes through our own server,
    // so there is no CORS story to get wrong.
    proxy: {
      '/api': SERVER,
      '/comfy': { target: SERVER, ws: true },
    },
  },
});
