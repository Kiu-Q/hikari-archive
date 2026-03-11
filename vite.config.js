import { defineConfig, loadEnv } from 'vite';
import electron from 'vite-plugin-electron';
import electronRenderer from 'vite-plugin-electron-renderer';
import path from 'path';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd());
  
  const isWeb = mode === 'web';
  
  // Set base path for GitHub Pages deployment
  const base = isWeb && env.VITE_BASE_URL ? env.VITE_BASE_URL : '/';
  
  return {
    base,
    plugins: [
      ...(isWeb ? [] : [
        electron([
          {
            entry: './main.js',
            vite: {
              build: {
                outDir: 'dist-electron',
                rollupOptions: {
                  external: ['electron']
                }
              }
            }
          }
        ]),
        electronRenderer()
      ])
    ],
    root: isWeb ? 'web' : 'electron',
    publicDir: isWeb ? 'assets' : '../assets',
    build: {
      outDir: isWeb ? '../dist' : '../dist',
      emptyOutDir: true,
      copyPublicDir: true,
      assetsInlineLimit: 4096,
      // Ensure assets are referenced correctly for GitHub Pages
      rollupOptions: {
        output: {
          assetFileNames: 'assets/[name]-[hash][extname]',
          chunkFileNames: 'assets/[name]-[hash].js',
          entryFileNames: (chunkInfo) => {
            // Keep app.js name for main entry, hash others
            if (chunkInfo.name === 'index') {
              return 'app.js';
            }
            return 'assets/[name]-[hash].js';
          }
        }
      }
    },
    assetsInclude: ['**/*.vrm', '**/*.vrma', '**/*.gif'],
    server: {
      port: mode === 'web' ? 8081 : 5174,
      open: false,
      host: '0.0.0.0',
      allowedHosts: 'node.tail9eee8d.ts.net'
    },
    preview: {
      port: 3000,
      host: '0.0.0.0'
    },
    define: {
      'import.meta.env.VITE_MODE': JSON.stringify(mode),
      'import.meta.env.VITE_WEBSOCKET_URL': JSON.stringify(env.VITE_WEBSOCKET_URL || 'ws://localhost:18789'),
      'import.meta.env.VITE_ASSET_BASE_URL': JSON.stringify(env.VITE_ASSET_BASE_URL || (isWeb ? './' : './assets/')),
      'import.meta.env.VITE_WINDOW_WIDTH': JSON.stringify(env.VITE_WINDOW_WIDTH || '600px'),
      'import.meta.env.VITE_WINDOW_HEIGHT': JSON.stringify(env.VITE_WINDOW_HEIGHT || '900px'),
    },
    optimizeDeps: {
      include: ['three', '@pixiv/three-vrm', '@pixiv/three-vrm-animation']
    }
  };
});
