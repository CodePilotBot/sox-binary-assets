#!/usr/bin/env bash
# usage: xbuild_mac.sh <x86_64|arm64>
set -euo pipefail
ARCH=$1
S=/tmp/claude-0/-home-claude/fe35e18a-d1c9-5779-ae2a-4d5ed44b745f/scratchpad
SDK=$S/src/macsdk/MacOSX11.3.sdk
case $ARCH in x86_64) MIN=10.13; HOST=x86_64-apple-darwin;; arm64) MIN=11.0; HOST=aarch64-apple-darwin;; esac
T=$ARCH-apple-macos$MIN
R=$S/mac-$ARCH; D=$R/deps; B=$R/build
mkdir -p $R/bin $D $B
export PATH=$R/bin:$PATH
J=$(nproc)
log(){ echo "[$(date +%T)] mac-$ARCH: $*"; }
cat > $R/bin/cc <<EOF
#!/bin/sh
exec clang --target=$T -isysroot $SDK -fuse-ld=lld -Wno-unused-command-line-argument "\$@"
EOF
sed "s/^exec clang /exec clang++ /" $R/bin/cc > $R/bin/cxx
chmod +x $R/bin/cc $R/bin/cxx
for t in ar ranlib nm strip lipo; do ln -sf $(which llvm-$t) $R/bin/$t; done
ln -sf $(which llvm-libtool-darwin) $R/bin/libtool 2>/dev/null || true
export CC=$R/bin/cc AR=$R/bin/ar RANLIB=$R/bin/ranlib NM=$R/bin/nm STRIP=$R/bin/strip

log cmake-deps
cat > $R/tc.cmake <<EOF
set(CMAKE_SYSTEM_NAME Darwin)
set(CMAKE_SYSTEM_PROCESSOR $ARCH)
set(CMAKE_OSX_ARCHITECTURES $ARCH)
set(CMAKE_C_COMPILER $R/bin/cc)
set(CMAKE_CXX_COMPILER $R/bin/cxx)
set(CMAKE_AR $R/bin/ar)
set(CMAKE_RANLIB $R/bin/ranlib)
set(CMAKE_FIND_ROOT_PATH $D)
set(CMAKE_FIND_ROOT_PATH_MODE_PROGRAM NEVER)
set(CMAKE_FIND_ROOT_PATH_MODE_LIBRARY BOTH)
set(CMAKE_FIND_ROOT_PATH_MODE_INCLUDE BOTH)
set(CMAKE_TRY_COMPILE_TARGET_TYPE STATIC_LIBRARY)
EOF
C="cmake -G Ninja -DCMAKE_TOOLCHAIN_FILE=$R/tc.cmake -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX=$D -DBUILD_SHARED_LIBS=OFF -DCMAKE_POLICY_VERSION_MINIMUM=3.5"
mkdir -p $B/ogg $B/vorbis $B/flac
(cd $B/ogg && $C -DBUILD_TESTING=OFF -DINSTALL_DOCS=OFF $S/src/ogg >log 2>&1 && ninja install >>log 2>&1)
(cd $B/vorbis && $C -DBUILD_TESTING=OFF -DCMAKE_PREFIX_PATH=$D $S/src/vorbis >log 2>&1 && ninja install >>log 2>&1)
(cd $B/flac && $C -DBUILD_CXXLIBS=OFF -DBUILD_PROGRAMS=OFF -DBUILD_EXAMPLES=OFF -DBUILD_TESTING=OFF -DBUILD_DOCS=OFF -DINSTALL_MANPAGES=OFF -DWITH_OGG=ON -DENABLE_MULTITHREADING=OFF -DWITH_STACK_PROTECTOR=OFF -DWITH_FORTIFY_SOURCE=OFF -DCMAKE_PREFIX_PATH=$D $S/src/flac >log 2>&1 && ninja install >>log 2>&1)
ls $D/lib

log lame
mkdir -p $B/lame && cd $B/lame
$S/src/lame/configure --host=$HOST --prefix=$D --disable-shared --enable-static --disable-frontend --disable-decoder --disable-gtktest --disable-analyzer-hooks CFLAGS="-O2" >cfg.log 2>&1
make -j$J >mk.log 2>&1; make install >/dev/null 2>&1
log libmad
mkdir -p $B/libmad && cd $B/libmad
$S/src/libmad/configure --host=$HOST --prefix=$D --disable-shared --enable-static --enable-fpm=64bit --disable-debugging CFLAGS="-O2" >cfg.log 2>&1
sed -i 's/-fforce-mem//g;s/-fthread-jumps//g;s/-fcse-follow-jumps//g;s/-fcse-skip-blocks//g;s/-fregmove//g;s/-fexpensive-optimizations//g;s/-fschedule-insns2//g' Makefile
make -j$J >mk.log 2>&1; make install >/dev/null 2>&1
log gsm
mkdir -p $B/gsm && cd $B/gsm
for f in $S/src/libgsm/src/*.c; do case $(basename $f) in toast*) continue;; esac
  $CC -O2 -DNeedFunctionPrototypes=1 -DSASR -DWAV49 -I$S/src/libgsm/inc -c $f -o $(basename $f .c).o 2>>err.log; done
$AR rcs libgsm.a *.o; mkdir -p $D/include/gsm; cp $S/src/libgsm/inc/gsm.h $D/include/; cp $S/src/libgsm/inc/gsm.h $D/include/gsm/; cp libgsm.a $D/lib/
ls $D/lib

log sox
mkdir -p $B/sox && cd $B/sox
PKG_CONFIG_PATH=$D/lib/pkgconfig PKG_CONFIG_LIBDIR=$D/lib/pkgconfig $S/src/sox-w/configure --host=$HOST --prefix=$R/out --disable-shared --enable-static --disable-openmp --disable-symlinks --without-magic --without-png --without-ladspa --without-oss --without-alsa --without-ao --without-pulseaudio --without-sndio --without-coreaudio --without-id3tag --without-twolame --without-opus --without-amrnb --without-amrwb --without-wavpack --without-sndfile --without-libltdl --with-mad --with-lame --with-flac --with-oggvorbis --with-gsm CPPFLAGS="-I$D/include -DFLAC__NO_DLL" LDFLAGS="-L$D/lib" CFLAGS="-O2" > cfg.log 2>&1
grep -E "^  (mp3|flac|gsm|oggvorbis) " cfg.log
make -j$J > mk.log 2>&1 || { grep -E "error|undefined" mk.log | head; exit 1; }
cp src/sox $R/sox
llvm-strip -x $R/sox 2>/dev/null || true
file $R/sox; llvm-objdump --macho --private-headers $R/sox | grep -E "LC_CODE_SIGNATURE|minos|name /" 
log DONE
