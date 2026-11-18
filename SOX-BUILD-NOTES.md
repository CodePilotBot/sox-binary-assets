# SoX vendor binaries: build notes

Date: 2026-11-17. This document describes how the Windows and macOS `sox` binaries in `vendor/` were built.
The three Linux binaries (`linux-x64`, `linux-arm`, `linux-arm64`) were already in the bundle and were **not** built here.

## 0. Versions at a glance

**SoX** reports `SoX v14.4.2` (`sox --version`, confirmed on the Linux x64 binary and on Windows x64). Windows and macOS builds come from the `chirlu/sox` git snapshot `42b3557` (2021-05-09); its `configure.ac` says `14.4.3git`, while the built binary prints `v14.4.2`.

| Component | Version | Used for |
|---|---|---|
| SoX | v14.4.2 (git `42b3557`) | main program |
| LAME | 3.100 (git `af98467`) | MP3 encoding |
| libmad | 0.15.1b (git `c2f96fa`) | MP3 decoding |
| FLAC | 1.5.0 (git `59fa340`) | FLAC read/write |
| libogg | 1.3.6 (git `06a5e02`) | OGG container |
| libvorbis | 1.3.7 (git `1b75110`) | Vorbis codec |
| libgsm | 1.0 patchlevel 17 (git `98f1708`) | GSM codec |

| Build tooling | Version |
|---|---|
| clang / LLD | 18.1.3 (Ubuntu 1ubuntu1) |
| CMake | 3.28.3 |
| mingw-w64 (headers + CRT) | git `93f3505` (2024-09-24), UCRT |
| compiler-rt builtins | LLVM 18.1.3 (`llvmorg-18.1.3`) |
| macOS SDK | 11.3 (`alexey-lysiuk/macos-sdk`) |
| Windows minimum | Windows 10 (or 7/8 with the Universal CRT update) |
| macOS minimum | 10.13 (Intel), 11.0 (Apple Silicon) |

Note: the codec versions above are the ones in the Windows and macOS builds. The three Linux binaries were built by someone else, so their library versions are unknown.

## 1. What is in `vendor/`

| Folder | Platform | Built by | Tested on a real OS? | Size (bytes) | SHA-256 |
|---|---|---|---|---|---|
| `linux-x64` | Linux x86-64 | provided in the original zip | n/a (original) | 3722904 | `4c57cfe217cf6ca1037cbcea2b1faa757c3e7e6d39ceb0640fbd0ab4fc3cc0a9` |
| `linux-arm` | Linux ARM 32-bit | provided in the original zip | n/a (original) | 2351228 | `77e63101d7b5707e9213b7f560bc1e5c5ca0f2c5c8c5db1302838e69e8ca868d` |
| `linux-arm64` | Linux ARM64 | provided in the original zip | n/a (original) | 3362776 | `585fdecacc017f5cf94e88402ab38178036f271e3d1612267f7121a913e9a065` |
| `win32-x64` | Windows 64-bit | cross-compiled | **Yes** (`--help`, mp3 → mp3 with `speed` + `reverb`) | 2176000 | `7f2cb823b3866792029342604d5af7371ef8fe933585ba6a9d07fb05bce496a5` |
| `win32-ia32` | Windows 32-bit | cross-compiled | No | 1934848 | `b75a391e1355469832e1c8c713576e48fe2317d98b9acf0a18ad8b0c0c6ba82e` |
| `win32-arm64` | Windows on ARM | cross-compiled | No | 1881088 | `d457d22b089530eb099268414050eb41ec7342c2a1db2f5ce45b21f1eb3ca5ff` |
| `darwin-x64` | macOS Intel | cross-compiled | No | 2100460 | `9348f0237402db8ab1be1e6f86fe8f60aadfbe6e228d8ac237431311f95c6b0f` |
| `darwin-arm64` | macOS Apple Silicon | cross-compiled | No | 1924448 | `7db677ad7cbf634936bdad6f85452624dc94b916b52f545fc5a6ee2cdd8708c4` |

`slowed-reverb.mjs` picks `vendor/<process.platform>-<process.arch>/sox` (`sox.exe` on Windows).

## 2. Build environment

Everything was cross-compiled on a Linux x86-64 sandbox. No Windows or macOS machine was used, and the resulting binaries were not run in the sandbox.

- Compiler: Ubuntu clang 18.1.3, linker: LLD 18.1.3 (`ld.lld` for Windows via `-fuse-ld=lld`, `ld64.lld` for macOS)
- Build tools: CMake 3.28.3, Ninja, GNU make, autoconf/automake/libtool, llvm-ar/ranlib/nm/strip/objdump/dlltool/windres
- Network: only `git clone` from GitHub worked. SourceForge, plain `curl` and package managers were blocked, so every source came from a GitHub mirror.

### Source versions

| Component | Repo | Commit | Commit date |
|---|---|---|---|
| SoX | `chirlu/sox` (mirror of the official repo, reports as v14.4.2) | `42b3557` | 2021-05-09 |
| LAME (MP3 encode) | `rbrito/lame` | `af98467` | 2017-08-02 |
| libmad (MP3 decode) | `markjeee/libmad` | `c2f96fa` | 2010-04-23 |
| FLAC | `xiph/flac` | `59fa340` | 2026-10-28 |
| libogg | `xiph/ogg` | `06a5e02` | 2026-03-02 |
| libvorbis | `xiph/vorbis` | `1b75110` | 2026-08-03 |
| libgsm | `timothytylee/libgsm` | `98f1708` | 2018-03-24 |
| mingw-w64 (Windows headers + CRT) | `mirror/mingw-w64` | `93f3505` | 2024-09-24 |
| compiler-rt builtins (Windows only) | `llvm/llvm-project` tag `llvmorg-18.1.3`, sparse checkout of `compiler-rt` | n/a | n/a |
| macOS SDK 11.3 | `alexey-lysiuk/macos-sdk` tag `11.3`, sparse checkout of `MacOSX11.3.sdk` | n/a | n/a |

## 3. Windows builds (x64, ia32, arm64)

Targets: `x86_64-w64-mingw32`, `i686-w64-mingw32`, `aarch64-w64-mingw32`. C runtime: **UCRT**. Default `_WIN32_WINNT` = 0x0601.

No mingw toolchain was installed, so one was assembled from source for each architecture:

1. Install mingw-w64 **headers** into a private sysroot.
2. Build **compiler-rt builtins** with clang and install them as `libgcc.a` (a stub `libgcc_eh.a` is added). This provides helpers such as `__chkstk`. For the x64 build, which was done first, a hand-written `___chkstk_ms` stub in assembly was used instead of compiler-rt.
3. Build the mingw-w64 **CRT** (`--enable-lib32`, `--enable-lib64` or `--enable-libarm64` depending on arch). A static hello-world link test is run after this step.
4. Build the codec libraries as static `.a`:
   - libogg, libvorbis, FLAC via CMake. FLAC options: `-DENABLE_MULTITHREADING=OFF -DWITH_STACK_PROTECTOR=OFF -DWITH_FORTIFY_SOURCE=OFF -DBUILD_PROGRAMS=OFF -DBUILD_CXXLIBS=OFF`.
   - LAME via `configure` (`--disable-frontend --disable-decoder`).
   - libmad via `configure` with `--enable-fpm=64bit` (portable C path, no assembly). The obsolete gcc-only flags (`-fforce-mem` and similar) are stripped from its Makefile. Its old `config.sub` is replaced with a newer one from automake so it recognises `aarch64-w64-mingw32`.
   - libgsm compiled directly with `-DSASR -DWAV49 -DNeedFunctionPrototypes=1`.
5. Build SoX:
   ```
   configure --host=<triple> --disable-shared --enable-static --disable-openmp --disable-symlinks \
     --without-{magic,png,ladspa,oss,alsa,ao,pulseaudio,sndio,coreaudio,id3tag,twolame,opus,amrnb,amrwb,wavpack,sndfile,libltdl} \
     --with-mad --with-lame --with-flac --with-oggvorbis --with-gsm \
     CPPFLAGS="-I<deps>/include -DFLAC__NO_DLL" LDFLAGS="-L<deps>/lib -static" CFLAGS="-O2"
   ```
   The result is stripped with `llvm-strip --strip-unneeded`.

Result: statically linked PE files, importing only Windows system DLLs (`api-ms-win-crt-*`, `KERNEL32.dll`, and `WINMM.dll` when the waveaudio driver was enabled). No extra DLLs need to ship.
`file` reports PE32+ x86-64, PE32 Intel 80386 and PE32+ Aarch64 respectively.

Requirement: Windows 10 or newer, or Windows 7/8 with the Universal C Runtime update installed.

## 4. macOS builds (x86_64, arm64)

Targets: `x86_64-apple-macos10.13` and `arm64-apple-macos11.0`, using the macOS 11.3 SDK (`-isysroot`) with `ld64.lld`.

- The same codec libraries were built as static `.a` files, with CMake for libogg/libvorbis/FLAC and `configure --host=<x86_64|aarch64>-apple-darwin` for LAME and libmad (`--enable-fpm=64bit`). The CMake toolchain file also sets a C++ compiler because FLAC's CMake project requires one.
- SoX was configured with the same flags as on Windows, except no `-static` (macOS cannot link fully static).
- The `arm64` binary carries an ad-hoc code signature (`LC_CODE_SIGNATURE`), which Apple Silicon requires. LLD adds it automatically.
- Dynamic dependencies: `/usr/lib/libSystem.B.dylib` and the CoreAudio framework (both ship with macOS). All codecs are linked statically.

If Gatekeeper blocks a downloaded binary: `xattr -dr com.apple.quarantine vendor/` and `chmod +x vendor/darwin-*/sox`.

## 5. Modifications to SoX source

Two small changes were made in the working copy used for the Windows and macOS builds:

1. `configure.ac`: removed the three `AX_APPEND_*` lines (`-fstack-protector-strong`, warning flags, `-Wl,--as-needed`). The `autoconf-archive` macros were not available and the flags are not wanted on these targets. Then `autoreconf -fi` was run.
2. `src/formats.c`: the "cannot rewind a pipe" workaround that peeks into `FILE` internals was extended from MSVC-only to also cover UCRT (`|| defined _UCRT`), because `FILE` is opaque there. **Side effect on Windows builds:** format auto-detection when reading from a pipe/stdin is disabled. Normal file input and output are unaffected.

## 6. Feature check

Configure output reported `mp3 yes`, `flac yes`, `gsm yes`, `oggvorbis yes` for all six new builds, and the compiled objects reference both the decoder and encoder functions (`mad_frame_decode`, `lame_encode_buffer_float`, `ov_open_callbacks`, `vorbis_analysis_init`, `FLAC__stream_decoder_new`, `FLAC__stream_encoder_new`, `gsm_decode`, `gsm_encode`).

Output of `win32-x64\sox.exe --help` on a real Windows machine:

- Version: `SoX v14.4.2`
- Formats include: `mp3 mp2 flac ogg vorbis gsm wav aiff` plus the usual raw/PCM formats
- All 13 effects used by `slowed-reverb.mjs` are present: `bass treble vol pitch speed tempo lowpass highpass chorus flanger echo reverb fade`
- Audio device driver: `waveaudio` (Windows only; the Linux builds have none)

A real conversion (`sox input.mp3 output.mp3 speed 0.85 reverb 40`) completed on Windows x64. The only output was normal clipping warnings from `reverb` and `rate`. Use `gain -4` before `speed`/`reverb`, or `-G`, to avoid them.

## 7. Known limitations

- Only `win32-x64` has been run on a real OS. `win32-ia32`, `win32-arm64`, `darwin-x64` and `darwin-arm64` are built and structurally verified (file type, linked libraries, codec symbols) but not executed.
- Windows builds have no stdin format auto-detect (see section 5).
- libmad uses the portable 64-bit arithmetic path, so MP3 decoding is slightly slower than an assembly-optimised build. Output is identical.
- The SoX source is a git snapshot of the official repository, not the 14.4.2 release tarball (SourceForge was not reachable).
- Not built: Linux 32-bit x86, RISC-V, BSD, and others.

## 8. Rebuild scripts (in `tools/`)

- `cross-build-win.sh <i686|aarch64>`: full Windows toolchain + deps + SoX build from Linux
- `cross-build-macos.sh <arm64|x86_64>`: macOS build from Linux
- `build-sox-windows.sh` + `.github/workflows/build-sox-windows.yml`: alternative native x64 build with MSYS2 on GitHub Actions (written from a published recipe; **never executed**)

The two `cross-build-*.sh` scripts contain absolute paths of the sandbox where they were run; edit the variables at the top (`S=`, `SDK=`) before reusing them.
The `win32-x64` binary was built step by step by hand with the same commands as `cross-build-win.sh`; the script was generalised afterwards and used for ia32 and arm64.
