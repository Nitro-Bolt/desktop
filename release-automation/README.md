# Release automation

## Publishing a release

Run the `Release` workflow from the Actions tab and choose a release type:

- `current` publishes the version already in `package.json`.
- `update` increments the middle number and resets the bugfix number.
- `bugfix` increments the final number.

Enter one changelog item per line. The workflow updates the version and generated changelog files, commits and tags the release, builds every supported platform, and publishes the artifacts to GitHub Releases. Windows and macOS artifacts are not code signed.

The workflow uses the `AUTOMATION` repository secret to push the release commit and tag.

## Build script

`build.mjs` packages the compiled application. At least one target must be provided:

- `--windows`: Windows 10 and later installer.
- `--windows-legacy`: Windows 7, 8, and 8.1 installer using an older Electron version.
- `--windows-portable`: Portable Windows executable.
- `--microsoft-store`: Microsoft Store APPX package.
- `--windows-dir`: Unpacked Windows application for debugging.
- `--mac`: Current universal macOS disk image.
- `--mac-legacy-10.13-10.14`: Intel build for macOS 10.13 and 10.14.
- `--mac-legacy-10.15`: Intel build for macOS 10.15.
- `--mac-legacy-11`: Universal build for macOS 11.
- `--mac-dir`: Unpacked macOS application for debugging.
- `--debian`: Debian package.
- `--rpm`: RPM package.
- `--appimage`: Portable AppImage.
- `--tarball`: Portable tar.gz archive.
- `--linux-dir`: Unpacked Linux application for debugging.

Architecture options:

- `--x64`: 64-bit x86.
- `--ia32`: 32-bit x86 on Windows.
- `--arm64`: 64-bit ARM.
- `--armv7l`: 32-bit ARM on Linux.
- `--universal`: Combined Intel and Apple Silicon macOS build.

`--production` enables production update checks and legacy-build warnings.

Microsoft Store APPX packages use the public product identity from Partner Center. Microsoft signs packages accepted through the Store; the APPX files attached to GitHub releases are not signed for sideloading.

The script builds every requested target for every requested architecture. For example:

```sh
node release-automation/build.mjs --windows --windows-portable --x64 --arm64 --production
```

Optional dependencies:

- Git, used to obtain the most recent commit time.
- `strip-nondeterminism`, used to make Linux tar archives reproducible.
