import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: './',
  optimizeDeps: {
    entries: ['index.html'],
    include: ['@cove/client-core', '@cove/contracts'],
  },
  build: {
    commonjsOptions: { include: [/node_modules/, /packages[\\/].*[\\/]dist[\\/]/] },
  },
  server: {
    host: '127.0.0.1',
    port: Number(process.env.COVE_DEV_RENDERER_PORT ?? 55173),
    strictPort: true,
  },
});
