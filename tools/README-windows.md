# Windows Binary (vendor/)

| Folder | Architecture | Status |
|---------------------|----------------------------------|-----------------------------------|
| vendor/win32-x64 | Windows 64-bit | tested on Windows |
| vendor/win32-ia32 | Windows 32-bit | not tested |
| vendor/win32-arm64 | Windows on ARM | not tested |

All static (SoX git master ~14.4.2 + LAME, libmad, FLAC, ogg/vorbis, libgsm), only imports Windows system DLLs
(UCRT, KERNEL32). Requires Windows 10+ (or Win 7/8 with Universal CRT update).
Note: Auto-detection of the pipe (stdin) format is disabled (UCRT effect). Normal file input/output is unaffected.

The script searches the `vendor/<process.platform>-<process.arch>/sox.exe` folder automatically.
Test: `vendor\win32-ia32\sox.exe --version`

Rebuild: `tools/cross-build-win.sh i686|aarch64` (cross-compile from Linux using clang + mingw-w64; see path above script),
or GitHub Actions `build-sox-windows` (MSYS2, x64).

# macOS (vendor/darwin-*)

| Folders | Architecture | Status |
|--------------------|-----------------------|--------------|
| vendor/darwin-arm64 | Apple Silicon (M1+) | not tested yet |
| vendor/darwin-x64 | Intel Macs | not tested yet |

Cross-compile from Linux (clang + lld + SDK macOS 11.3; arm64 min macOS 11.0, Intel min 10.13), no Mac required.
Dynamic linking only to libSystem + CoreAudio (default macOS), other codecs are static. The arm64 binary is ad-hoc signed.
If macOS blocks ("cannot verify"): `xattr -dr com.apple.quarantine vendor/` then `chmod +x vendor/darwin-*/sox`.
Rebuild: `tools/cross-build-macos.sh arm64|x86_64` (adjust the SDK path above the script).