import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd());
  
  return {
    root: '.',
    base: mode === 'web' ? './' : '/',
    build: {
      outDir: mode === 'web' ? 'dist' : 'renderer/dist',
      emptyOutDir: true,
      rollupOptions: {
        input: mode === 'web' ? ['index.html', 'renderer/index-web.html'] : 'renderer/index.html',
      },
    },
    publicDir: 'renderer/assets',
    server: {
      port: mode === 'web' ? 8081 : 5174,
      open: false,
      host: '0.0.0.0',
      allowedHosts: 'node.tail9eee8d.ts.net'
    },
    preview: {
      port: 3000,
      host: '0.0.0.0',
      open: false,
      base: './'
    },
    define: {
      'import.meta.env.VITE_MODE': JSON.stringify(mode),
      'import.meta.env.VITE_WEBSOCKET_URL': JSON.stringify(env.VITE_WEBSOCKET_URL || 'ws://localhost:18789'),
      'import.meta.env.VITE_ASSET_BASE_URL': JSON.stringify(env.VITE_ASSET_BASE_URL || './assets/'),
      'import.meta.env.VITE_WINDOW_WIDTH': JSON.stringify(env.VITE_WINDOW_WIDTH || '600px'),
      'import.meta.env.VITE_WINDOW_HEIGHT': JSON.stringify(env.VITE_WINDOW_HEIGHT || '900px'),
    },
    optimizeDeps: {
      include: ['three', '@pixiv/three-vrm', '@pixiv/three-vrm-animation']
    }
  };
});
