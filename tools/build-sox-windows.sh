#!/usr/bin/env bash
# Build SoX 14.4.2 STATIC buat Windows x64 (tanpa DLL), dijalanin di shell MSYS2 MINGW64.
# Resep dasar: https://gist.github.com/HerrPi/be902ecef27295627671552bde43d180
# Hasil: out/win32-x64/sox.exe
set -euo pipefail

pacman -S --needed --noconfirm base-devel patch autoconf automake libtool pkgconf \
  mingw-w64-x86_64-toolchain \
  mingw-w64-x86_64-lame mingw-w64-x86_64-libmad \
  mingw-w64-x86_64-flac mingw-w64-x86_64-libogg mingw-w64-x86_64-libvorbis \
  mingw-w64-x86_64-gsm mingw-w64-x86_64-opusfile

work="$(mktemp -d)"; cd "$work"
curl -fL -o sox.tar.gz https://downloads.sourceforge.net/project/sox/sox/14.4.2/sox-14.4.2.tar.gz
tar xf sox.tar.gz && cd sox-14.4.2

./configure --prefix="$work/inst" \
  --disable-shared --enable-static \
  --disable-openmp --disable-symlinks \
  --without-magic --without-png --without-ladspa --without-oss --without-alsa \
  --without-ao --without-pulseaudio --without-sndio --without-waveaudio \
  --with-mad --with-lame --with-flac --with-oggvorbis --with-gsm \
  LDFLAGS="-static" \
  PKG_CONFIG="pkg-config --static"

make -j"$(nproc)" LDFLAGS="-static -all-static"
strip src/sox.exe

dest="${GITHUB_WORKSPACE:-$HOME}/out/win32-x64"; mkdir -p "$dest"
cp src/sox.exe "$dest/"
"$dest/sox.exe" --version
ntldd "$dest/sox.exe" 2>/dev/null || true   # cek: harus cuma DLL sistem Windows
