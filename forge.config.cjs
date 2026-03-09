module.exports = {
  packagerConfig: {
    asar: true,
    icon: './assets/icon',
    name: 'VRM Viewer',
    executableName: 'vrm-viewer',
    ignore: [
      /^\/src/,
      /^\/renderer\/assets\/(?!VRM|VRMA)/,
      /^\/\.git/,
      /^\/node_modules\/.+\.(test|spec)\.js/,
    ],
  },
  rebuildConfig: {},
  makers: [
    {
      name: '@electron-forge/maker-squirrel',
      config: {
        name: 'vrm_viewer',
        authors: 'VRM Viewer Team',
        description: 'VRM Model Viewer Desktop Application',
      },
    },
    {
      name: '@electron-forge/maker-zip',
      platforms: ['darwin', 'linux', 'win32'],
    },
    {
      name: '@electron-forge/maker-deb',
      config: {},
    },
    {
      name: '@electron-forge/maker-rpm',
      config: {},
    },
  ],
  plugins: [
    {
      name: '@electron-forge/plugin-auto-unpack-natives',
      config: {},
    },
  ],
};