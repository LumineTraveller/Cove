import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: './',
  optimizeDeps: {
    entries: ['index.html'],
  },
  server: {
    port: 5173,
  },
});
