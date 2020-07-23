# Theia Tauri Example

Theia packaged as a [Tauri](https://tauri.studio) application.

## To Use

Currently only working in Linux

1. Follow the [devloping guide](https://github.com/eclipse-theia/theia/blob/master/doc/Developing.md) to get set up to run examples
2. Run `yarn install` in the root of this repo
3. `cd` into the `examples/tauri` folder and run `yarn install` to install deps
4. Package the Theia server as an executable with `yarn package-binary`
5. Run `yarn tauri build` to build the executable, executable in `src-tauri/target/release/theia`, .deb in `src-tauri/target/release/bundle/deb/theia_0.1.0_amd64.deb`
