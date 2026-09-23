import { defineConfig, loadEnv } from 'vite';
import electron from 'vite-plugin-electron';

export default defineConfig(({ mode, command }) => {
  const env = loadEnv(mode, process.cwd());
  
  const isWeb = mode === 'web';
  const isProduction = command === 'build';
  
  // Set base path for GitHub Pages deployment
  // For web mode in production, use VITE_BASE_URL if set, otherwise '/'
  const base = !isWeb && isProduction
    ? './'
    : (isWeb && isProduction && env.VITE_BASE_URL ? env.VITE_BASE_URL : '/');
  
  // Local Vite development always serves public assets from the server root.
  // `.env.web` contains the GitHub Pages prefix, which must only be applied
  // to production builds; using it during `vite --mode web` development makes
  // the VRM URL resolve to an HTML fallback page instead of the model.
  let assetBaseUrl;
  if (isWeb) {
    assetBaseUrl = isProduction
      ? (env.VITE_ASSET_BASE_URL || '/assets/')
      : '/';
  } else {
    // Electron assets are served from the public root in dev and copied next
    // to index.html in packaged builds.
    assetBaseUrl = isProduction ? './' : '/';
  }
  
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
        ])
      ])
    ],
    root: isWeb ? 'web' : 'electron',
    publicDir: 'assets',
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
      allowedHosts: 'node.tail9eee8d.ts.net',
      proxy: {
        '/__openclaw__': {
          target: env.VITE_GATEWAY_URL || 'http://localhost:18789',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/__openclaw__/, '')
        }
      }
    },
    preview: {
      port: 3000,
      host: '0.0.0.0'
    },
    define: {
      'import.meta.env.VITE_MODE': JSON.stringify(mode),
      'import.meta.env.VITE_GATEWAY_URL': JSON.stringify(env.VITE_GATEWAY_URL || 'http://localhost:18789'),
      'import.meta.env.VITE_ASSET_BASE_URL': JSON.stringify(assetBaseUrl),
      'import.meta.env.VITE_WINDOW_WIDTH': JSON.stringify(env.VITE_WINDOW_WIDTH || '600px'),
      'import.meta.env.VITE_WINDOW_HEIGHT': JSON.stringify(env.VITE_WINDOW_HEIGHT || '900px'),
    },
    optimizeDeps: {
      include: ['three', '@pixiv/three-vrm', '@pixiv/three-vrm-animation']
    }
  };
});
