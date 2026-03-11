module.exports = {
  packagerConfig: {
    name: 'Hikari',
    executableName: 'hikari',
    icon: './favicon.ico',
    asar: true,
  },
  rebuildConfig: {},
  makers: [
    {
      name: '@electron-forge/maker-squirrel',
      config: {
        name: 'Hikari',
        authors: 'Your Name',
        description: 'Hikari VRM Viewer',
        setupIcon: './favicon.ico'
      },
    },
    {
      name: '@electron-forge/maker-zip',
      platforms: ['darwin'],
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
  publishers: [],
};