// electron-builder's afterPack hook: hardens the packaged Electron binary.
// Node mode, NODE_OPTIONS and --inspect are switched off, the app loads only
// from its asar and the asar is checked against the hash embedded in the
// executable. Read them back with: npx @electron/fuses read --app <exe>
const { join } = require('node:path')
const { flipFuses, FuseVersion, FuseV1Options } = require('@electron/fuses')

module.exports = async function afterPack({ appOutDir, electronPlatformName, packager }) {
  const name = packager.appInfo.productFilename
  const binary =
    electronPlatformName === 'darwin' ? join(appOutDir, `${name}.app`, 'Contents', 'MacOS', name)
    : electronPlatformName === 'win32' ? join(appOutDir, `${name}.exe`)
    : join(appOutDir, name)
  await flipFuses(binary, {
    version: FuseVersion.V1,
    resetAdHocDarwinSignature: electronPlatformName === 'darwin',
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
    [FuseV1Options.EnableCookieEncryption]: true
  })
}
