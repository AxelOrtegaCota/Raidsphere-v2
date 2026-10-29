import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    host: '127.0.0.1', port: 5173, strictPort: true,
    proxy: { '/ws': { target: 'ws://127.0.0.1:3000', ws: true } },
  },
  preview: { host: '127.0.0.1' },
  build: { target: 'es2022', sourcemap: false },
});
