import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: './',
  cacheDir: process.env.COVE_VITE_CACHE_DIR || undefined,
  optimizeDeps: {
    entries: ['index.html'],
    include: ['@cove/client-core', '@cove/contracts'],
  },
  build: {
    // These tiny local cues must also decode in the packaged file:// renderer.
    // Leave every other asset on Vite's existing default policy.
    assetsInlineLimit(file) {
      if (/[/\\]audio[/\\]assets[/\\]voice-(join|leave)\.wav$/.test(file)) return true;
      return undefined;
    },
    commonjsOptions: { include: [/node_modules/, /packages[\\/].*[\\/]dist[\\/]/] },
  },
  server: {
    host: '127.0.0.1',
    port: Number(process.env.COVE_DEV_RENDERER_PORT ?? 55173),
    strictPort: true,
  },
});
