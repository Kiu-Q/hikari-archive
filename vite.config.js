import { defineConfig } from 'vite';
import electron from 'vite-plugin-electron';

// ============================================================
// CONFIGURATION
// ============================================================

const ASSET_BASE_URL = '/assets/';
const WEB_SOCKET_URL = process.env.VITE_WEBSOCKET_URL || '';

// ============================================================
// VITE CONFIGURATION
// ============================================================

export default defineConfig({
  // Base paths
  base: './',
  publicDir: 'public',

  // Build configuration
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('vendor')) {
            return `vendor-${id}`;
          }
          if (id.includes('three')) {
            return `three-vendor-${id}`;
          }
          return id;
        }
      }
    }
  },

  // Resolve aliases
  resolve: {
    // Three.js
    'three': 'three',
    'three/addons/': 'three/addons/',
    
    // VRM libraries
    '@pixiv/three-vrm': '@pixiv/three-vrm',
    '@pixiv/three-vrm-animation': '@pixiv/three-vrm-animation'
  },

  // Plugins
  plugins: [
    // Electron plugin for desktop builds
    electron({
      // Vite options tailored for Electron
      build: {
        electronOptions: {
          nodeIntegration: true,
        contextIsolation: false,
          enableRemoteModule: false,
        preload: undefined
        },
        rollupOptions: {
          input: {
            // Treat external dependencies as external
            external: ['electron', 'three', '@pixiv/three-vrm', '@pixiv/three-vrm-animation']
          }
        }
      }
    })
  ],

  // CSS configurations for both environments
  css: {
    preprocessorOptions: {
      scss: {
        api: 'modern-compiler'
      }
    }
  },

  // Server configuration (for development)
  server: {
    port: 5173,
    strictPort: true,
    host: '0.0.0.0',
    hmr: true
  },

  // Optimize dependencies
  optimizeDeps: {
    include: [],
    exclude: []
  },

  // Environment variables
  define: {
    // Asset base URL - passed to client via VITE_ASSET_BASE_URL
    'import.meta.env.VITE_ASSET_BASE_URL': JSON.stringify(ASSET_BASE_URL),
    
    // WebSocket URL - passed to client via VITE_WEBSOCKET_URL
    'import.meta.env.VITE_WEBSOCKET_URL': JSON.stringify(WEB_SOCKET_URL)
  },

  // Clear screen before building
  clearScreen: false,

  // Application configuration
  appType: 'spa'
});