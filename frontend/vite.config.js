import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from "path";
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Dev-only utilities that must never be shipped in a production bundle.
// Vite tree-shakes them automatically in production because no component
// imports them — but this explicit external guard is a belt-and-suspenders
// safeguard in case someone accidentally adds an import.
function devOnlyExternals() {
  return {
    name: 'dev-only-externals',
    resolveId(id) {
      if (process.env.NODE_ENV !== 'development' && id.includes('devLogin')) {
        // Return a virtual empty module so the build never bundles the file.
        return '\0dev-only-stub';
      }
    },
    load(id) {
      if (id === '\0dev-only-stub') return 'export default {}';
    },
  };
}

export default defineConfig({
  plugins: [react(), devOnlyExternals()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    environment: 'jsdom',
    environmentOptions: {
      jsdom: { url: 'http://localhost' },
    },
    globals: true,
    setupFiles: ['./src/__tests__/setup.js'],
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/react') || id.includes('node_modules/react-dom')) {
            return 'vendor';
          }
          if (id.includes('node_modules/recharts')) {
            return 'charts';
          }
          if (id.includes('node_modules/lucide-react') || id.includes('node_modules/react-icons')) {
            return 'icons';
          }
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:5000',
        changeOrigin: true,
      },
    },
  },
});