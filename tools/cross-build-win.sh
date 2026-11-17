#!/usr/bin/env bash
# usage: xbuild.sh <i686|aarch64>
set -euo pipefail
ARCH=$1
S=/tmp/claude-0/-home-claude/fe35e18a-d1c9-5779-ae2a-4d5ed44b745f/scratchpad
T=$ARCH-w64-mingw32
R=$S/$ARCH; SYS=$R/sysroot/$T; D=$R/deps; B=$R/build
mkdir -p $R/bin $SYS $D $B
export PATH=$R/bin:$PATH
J=$(nproc)
log(){ echo "[$(date +%T)] $ARCH: $*"; }

# --- wrappers
cat > $R/bin/$T-clang <<EOF
#!/bin/sh
exec clang --target=$T --sysroot=$R/sysroot -isystem $SYS/include -fuse-ld=lld -Wno-unused-command-line-argument -L$SYS/lib "\$@"
EOF
cp $R/bin/$T-clang $R/bin/$T-gcc
sed -i "s#^exec clang .*#exec $R/bin/$T-clang \"\\\$@\"#" $R/bin/$T-gcc
for t in ar ranlib nm objdump strip; do ln -sf $(which llvm-$t) $R/bin/$T-$t; done
ln -sf $(which llvm-dlltool) $R/bin/$T-dlltool
printf '#!/bin/sh\nexec llvm-windres-18 --target=%s -I %s/include "$@"\n' $T $SYS > $R/bin/$T-windres
cp $R/bin/$T-windres $R/bin/windres
chmod +x $R/bin/*

# --- headers
log headers
mkdir -p $B/headers && cd $B/headers
$S/src/mingw-w64/mingw-w64-headers/configure --prefix=$SYS --host=$T --enable-sdk=all --with-default-win32-winnt=0x0601 --with-default-msvcrt=ucrt >/dev/null 2>&1
make install -j$J >/dev/null 2>&1

# --- builtins (libgcc replacement)
log builtins
mkdir -p $B/builtins && cd $B/builtins
cmake -G Ninja -S $S/src/llvm/compiler-rt/lib/builtins \
  -DCMAKE_SYSTEM_NAME=Windows -DCMAKE_C_COMPILER=$R/bin/$T-clang -DCMAKE_ASM_COMPILER=$R/bin/$T-clang \
  -DCMAKE_C_COMPILER_TARGET=$T -DCMAKE_ASM_COMPILER_TARGET=$T -DCMAKE_AR=$(which llvm-ar) -DCMAKE_RANLIB=$(which llvm-ranlib) \
  -DCMAKE_TRY_COMPILE_TARGET_TYPE=STATIC_LIBRARY -DCOMPILER_RT_DEFAULT_TARGET_ONLY=ON \
  -DCOMPILER_RT_BUILD_BUILTINS=ON -DCMAKE_BUILD_TYPE=Release > cfg.log 2>&1
ninja > mk.log 2>&1
BI=$(find . -name 'libclang_rt.builtins*.a' | head -1)
[ -n "$BI" ] || { echo "builtins gagal"; tail -20 cfg.log mk.log; exit 1; }
mkdir -p $SYS/lib
cp $BI $SYS/lib/libgcc.a
echo 'void __stub_gcc_eh(void){}' > stub.c; $R/bin/$T-clang -c stub.c -o stub.o
llvm-ar rcs $SYS/lib/libgcc_eh.a stub.o

# --- crt
log crt
mkdir -p $B/crt && cd $B/crt
case $ARCH in
 i686)    LIBS="--enable-lib32 --disable-lib64";;
 aarch64) LIBS="--disable-lib32 --disable-lib64 --enable-libarm64";;
esac
$S/src/mingw-w64/mingw-w64-crt/configure --prefix=$SYS --host=$T --with-sysroot=$SYS $LIBS --with-default-msvcrt=ucrt \
  CC=$T-clang AR=$T-ar RANLIB=$T-ranlib DLLTOOL=$T-dlltool AS="$T-clang -c" > cfg.log 2>&1
make -j$J > mk.log 2>&1
make install > inst.log 2>&1
# hello test
cat > $B/h.c <<'EOF'
#include <stdio.h>
#include <string.h>
#include <math.h>
int main(int c,char**v){char b[20000];memset(b,c,sizeof b);volatile double x=sin(c);volatile long long q=c;q=q*123456789LL/(c+7);printf("hi %f %d %lld\n",x,b[c],q);return 0;}
EOF
$T-clang -O2 -static $B/h.c -o $B/h.exe
file $B/h.exe

# --- cmake deps
log cmake-deps
cat > $R/tc.cmake <<EOF
set(CMAKE_SYSTEM_NAME Windows)
set(CMAKE_SYSTEM_PROCESSOR $ARCH)
set(CMAKE_C_COMPILER $R/bin/$T-clang)
set(CMAKE_C_COMPILER_TARGET $T)
set(CMAKE_AR $R/bin/$T-ar)
set(CMAKE_RANLIB $R/bin/$T-ranlib)
set(CMAKE_RC_COMPILER $R/bin/windres)
set(CMAKE_FIND_ROOT_PATH $D $SYS)
set(CMAKE_FIND_ROOT_PATH_MODE_PROGRAM NEVER)
set(CMAKE_FIND_ROOT_PATH_MODE_LIBRARY ONLY)
set(CMAKE_FIND_ROOT_PATH_MODE_INCLUDE ONLY)
set(CMAKE_TRY_COMPILE_TARGET_TYPE STATIC_LIBRARY)
EOF
C="cmake -G Ninja -DCMAKE_TOOLCHAIN_FILE=$R/tc.cmake -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX=$D -DBUILD_SHARED_LIBS=OFF -DCMAKE_POLICY_VERSION_MINIMUM=3.5"
mkdir -p $B/ogg $B/vorbis $B/flac
(cd $B/ogg && $C -DBUILD_TESTING=OFF -DINSTALL_DOCS=OFF $S/src/ogg >log 2>&1 && ninja install >>log 2>&1)
(cd $B/vorbis && $C -DBUILD_TESTING=OFF -DCMAKE_PREFIX_PATH=$D $S/src/vorbis >log 2>&1 && ninja install >>log 2>&1)
(cd $B/flac && $C -DBUILD_CXXLIBS=OFF -DBUILD_PROGRAMS=OFF -DBUILD_EXAMPLES=OFF -DBUILD_TESTING=OFF -DBUILD_DOCS=OFF -DINSTALL_MANPAGES=OFF -DWITH_OGG=ON -DENABLE_MULTITHREADING=OFF -DWITH_STACK_PROTECTOR=OFF -DWITH_FORTIFY_SOURCE=OFF -DCMAKE_PREFIX_PATH=$D $S/src/flac >log 2>&1 && ninja install >>log 2>&1)
ls $D/lib

# --- autotools deps
export CC=$T-clang AR=$T-ar RANLIB=$T-ranlib
log lame
mkdir -p $B/lame && cd $B/lame
$S/src/lame/configure --host=$T --prefix=$D --disable-shared --enable-static --disable-frontend --disable-decoder --disable-gtktest --disable-analyzer-hooks CFLAGS="-O2" >cfg.log 2>&1
make -j$J >mk.log 2>&1; make install >/dev/null 2>&1
log libmad
mkdir -p $B/libmad && cd $B/libmad
$S/src/libmad/configure --host=$T --prefix=$D --disable-shared --enable-static --enable-fpm=64bit --disable-debugging CFLAGS="-O2" >cfg.log 2>&1
sed -i 's/-fforce-mem//g;s/-fthread-jumps//g;s/-fcse-follow-jumps//g;s/-fcse-skip-blocks//g;s/-fregmove//g;s/-fexpensive-optimizations//g;s/-fschedule-insns2//g' Makefile
make -j$J >mk.log 2>&1; make install >/dev/null 2>&1
log gsm
mkdir -p $B/gsm && cd $B/gsm
for f in $S/src/libgsm/src/*.c; do case $(basename $f) in toast*) continue;; esac
  $CC -O2 -DNeedFunctionPrototypes=1 -DSASR -DWAV49 -I$S/src/libgsm/inc -c $f -o $(basename $f .c).o 2>>err.log; done
$AR rcs libgsm.a *.o; mkdir -p $D/include/gsm; cp $S/src/libgsm/inc/gsm.h $D/include/ ; cp $S/src/libgsm/inc/gsm.h $D/include/gsm/; cp libgsm.a $D/lib/

# --- sox
log sox
mkdir -p $B/sox && cd $B/sox
PKG_CONFIG_PATH=$D/lib/pkgconfig PKG_CONFIG_LIBDIR=$D/lib/pkgconfig $S/src/sox-w/configure --host=$T --prefix=$R/out --disable-shared --enable-static --disable-openmp --disable-symlinks --without-magic --without-png --without-ladspa --without-oss --without-alsa --without-ao --without-pulseaudio --without-sndio --without-coreaudio --without-id3tag --without-twolame --without-opus --without-amrnb --without-amrwb --without-wavpack --without-sndfile --without-libltdl --with-mad --with-lame --with-flac --with-oggvorbis --with-gsm CPPFLAGS="-I$D/include -DFLAC__NO_DLL" LDFLAGS="-L$D/lib -static" CFLAGS="-O2" > cfg.log 2>&1
grep -E "^  (mp3|flac|gsm|oggvorbis) " cfg.log
make -j$J > mk.log 2>&1 || { grep -E "error|undefined" mk.log | head; exit 1; }
llvm-strip --strip-unneeded -o $R/sox.exe src/sox.exe
file $R/sox.exe; llvm-objdump -p $R/sox.exe | grep "DLL Name"
log DONE
