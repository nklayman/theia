/**
 * This script is used to copy the vscode-ripgrep binary and rename the Theia binary with the platform specific suffix.
 * When `tauri build` is ran, it looks for the binary name appended with the platform specific suffix.
 */

const execa = require('execa')
const fs = require('fs')

async function main() {
  const rustTargetInfo = JSON.parse(
    (
      await execa(
        'rustc',
        ['-Z', 'unstable-options', '--print', 'target-spec-json'],
        {
          env: {
            RUSTC_BOOTSTRAP: 1
          }
        }
      )
    ).stdout
  )
  const platformSuffix = rustTargetInfo['llvm-target']
  fs.copyFileSync(
    require.resolve('vscode-ripgrep/bin/rg'),
    `src-tauri/theia-binaries/rg-${platformSuffix}`
  )
  fs.renameSync(
    'src-tauri/theia-binaries/theia',
    `src-tauri/theia-binaries/theia-${platformSuffix}`
  )
}

main().catch((e) => {
  throw e
})
