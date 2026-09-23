// Keep the macOS bundle identity stable between builds so TCC can associate
// permissions (for example Screen Recording) with the packaged application.
// If no Apple certificate is available, still re-sign the finished bundle
// ad-hoc. This gives the current build a coherent Hikari identifier, but its
// designated requirement can change on every rebuild. To retain permission
// across rebuilds, set HIKARI_MAC_SIGNING_IDENTITY to a real Apple Development
// or Developer ID identity before packaging.
const macSigningIdentity = process.env.HIKARI_MAC_SIGNING_IDENTITY?.trim();
const macSignConfig = macSigningIdentity
  ? {
      identity: macSigningIdentity,
      hardenedRuntime: true,
    }
  : {
      // Keep nested Electron signatures coherent for local, certificate-free
      // builds. This is launchable but not a persistent signing identity.
      identity: '-',
      identityValidation: false,
      optionsForFile: () => ({
        hardenedRuntime: false,
        timestamp: false,
      }),
    };

module.exports = {
  packagerConfig: {
    name: 'Hikari',
    executableName: 'hikari',
    appBundleId: 'com.electron.hikari',
    osxSign: macSignConfig,
    icon: './favicon.ico',
    extraResource: ['./tools/companion-tts', './tools/media-state'],
    // Native Node addons cannot be loaded directly from an ASAR archive.
    // Keep the app archived while placing native addons and get-windows' helper
    // executable beside it.
    asar: {
      unpack: '{**/*.node,**/get-windows/main}',
    },
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
