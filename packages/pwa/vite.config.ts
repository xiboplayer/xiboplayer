import { defineConfig } from 'vite';
import path from 'path';
import { readFileSync } from 'fs';

const pkg = JSON.parse(readFileSync(path.resolve(__dirname, 'package.json'), 'utf-8'));

const common = {
  __APP_VERSION__: JSON.stringify(pkg.version),
  __BUILD_DATE__: JSON.stringify(new Date().toISOString()),
};

// App build (main + setup HTML pages)
const app = defineConfig({
  define: common,
  base: './',
  build: {
    outDir: 'dist',
    sourcemap: true,
    rollupOptions: {
      external: ['hls.js'],
      input: {
        main: path.resolve(__dirname, 'index.html'),
        setup: path.resolve(__dirname, 'setup.html'),
      },
    },
  },
  server: {
    port: 5174,
    proxy: {
      '/xmds.php': {
        target: 'http://localhost:8080',
        changeOrigin: true,
      },
    },
  },
});

// Service Worker build — isolated so no DOM globals leak into SW context
const sw = defineConfig({
  define: common,
  base: './',
  build: {
    outDir: 'dist',
    sourcemap: true,
    emptyOutDir: false,  // preserve app build output
    modulePreload: false,
    rollupOptions: {
      input: {
        sw: path.resolve(__dirname, 'public/sw-pwa.js'),
      },
      output: {
        entryFileNames: 'sw-pwa.js',
        chunkFileNames: 'assets/sw-[name]-[hash].js',
      },
    },
  },
});

export default process.env.BUILD_SW ? sw : app;
