#!/usr/bin/env node
// slowed-reverb.mjs
// Tool CLI + library ESM buat nambahin efek audio (termasuk preset
// "slowed + reverb") tanpa perlu root/install sistem.
//
// BACKEND (otomatis, urutan prioritas):
//   1. Binary SoX di folder vendor/<platform>-<arch>/sox — di-compile SENDIRI
//      dari source resmi SoX (bukan repack pihak ketiga), full-static (zero
//      dependency), sudah termasuk codec MP3/FLAC/OGG/Vorbis/GSM native.
//      Taruh file ini SATU FOLDER sama folder vendor/ biar kedetect.
//   2. npm package sox-bin — fallback kalau arch gak ada di folder vendor/.
//   3. FFmpeg (ffmpeg-static) — fallback terakhir kalau SoX gak bisa jalan
//      sama sekali di arch/platform ini.
//
// INSTALL (fallback #2 & #3, opsional tapi disarankan buat jaga-jaga):
//   npm install sox-bin ffmpeg-static fluent-ffmpeg
//
// PAKAI SEBAGAI CLI:
//   node slowed-reverb.mjs input.mp3 output.mp3
//   node slowed-reverb.mjs input.mp3 output.mp3 --speed=0.8 --reverb=70 --bass=3
//
// PAKAI SEBAGAI LIBRARY:
//   import { slowedReverb, addEffect, getBackend } from './slowed-reverb.mjs';
//   await slowedReverb('input.mp3', 'output.mp3', { speed: 0.85, reverb: 50 });
//
// Catatan: file ini .mjs jadi otomatis dianggap ESM oleh Node, gak perlu
// ubah "type" di package.json.

import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { execFile, execFileSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ===========================================================================
// 1. AUTO-FIX BUG PACKAGING sox-bin
//    Beberapa file di dalam sox-bin (symlink asli di sistem sumbernya)
//    ke-publish ke npm sebagai file teks biasa berisi nama target, bukan
//    symlink beneran. Kejadian di banyak arch (x86_64, i686, freebsd).
//    Deteksi otomatis: file kecil, bukan ELF/Mach-O, isinya cocok nama file
//    lain di folder yang sama -> perbaiki jadi symlink asli.
// ===========================================================================
function fixBrokenSymlinksInDir(dir) {
  if (!fs.existsSync(dir)) return;

  for (const name of fs.readdirSync(dir)) {
    const fullPath = path.join(dir, name);
    let stat;
    try {
      stat = fs.lstatSync(fullPath);
    } catch {
      continue;
    }

    if (stat.isDirectory()) {
      fixBrokenSymlinksInDir(fullPath); // rekursif buat lib/, bin/, dst.
      continue;
    }
    if (stat.isSymbolicLink() || !stat.isFile()) continue;
    if (stat.size === 0 || stat.size > 255) continue; // symlink asli isinya pendek

    const buf = fs.readFileSync(fullPath);
    const magic = buf.slice(0, 4).toString('hex');
    const isElf = magic === '7f454c46';
    const isMachO = ['cffaedfe', 'feedface', 'cafebabe'].includes(magic);
    if (isElf || isMachO) continue; // binary asli, bukan file rusak

    const target = buf.toString('utf8').trim();
    if (!target || target.includes('\n') || target.includes('\0')) continue;

    const targetPath = path.join(dir, target);
    if (fs.existsSync(targetPath) && target !== name) {
      fs.unlinkSync(fullPath);
      fs.symlinkSync(target, fullPath);
      console.log(`[audio-effects] Symlink diperbaiki: ${name} -> ${target}`);
    }
  }
}

// ===========================================================================
// 2. DETEKSI BACKEND — urutan prioritas:
//    a) Binary SoX yang di-COMPILE SENDIRI dari source resmi (folder vendor/
//       di sebelah file ini). Full-static (zero dependency), sudah termasuk
//       MP3/FLAC/OGG/Vorbis/GSM native, SoX v14.4.2 — lebih baru & lengkap
//       dari sox-bin (v14.4.1, tanpa MP3). INI YANG DIPAKAI KALAU ADA.
//    b) npm package sox-bin, kalau vendor binary gak ada/gak cocok arch.
//    c) FFmpeg (ffmpeg-static), fallback terakhir kalau SoX sama sekali
//       gak bisa jalan di arch/platform ini.
//
//    PENTING (beda dari versi CJS): sox-bin langsung throw pas di-import
//    kalau arch gak didukung. Supaya bisa ditangkep buat fallback, di sini
//    dipakai dynamic import() (bukan static "import ... from"), makanya
//    fungsi ini jadi async.
// ===========================================================================
let backend = null; // 'sox' | 'ffmpeg'
let soxPath = null;
let soxLibDir = null; // null kalau binary-nya full-static (gak butuh LD_LIBRARY_PATH)
let soxIsVendored = false;
let ffmpegPath = null;
let detectPromise = null; // cache promise biar deteksi cuma jalan sekali walau dipanggil paralel

/** Cari binary vendor/<platform>-<arch>/sox di sebelah file ini. */
function findVendoredSox() {
  // Windows: sox.exe (DLL pendukung, kalau ada, ditaruh di folder yang sama)
  const exe = process.platform === 'win32' ? 'sox.exe' : 'sox';
  const candidate = path.join(__dirname, 'vendor', `${process.platform}-${process.arch}`, exe);
  return fs.existsSync(candidate) ? candidate : null;
}

/** Env buat jalanin SoX. LD_LIBRARY_PATH cuma relevan di Linux (sox-bin). */
function soxEnv() {
  if (!soxLibDir || process.platform === 'win32') return process.env;
  return { ...process.env, LD_LIBRARY_PATH: soxLibDir };
}

/** Pastiin file punya bit executable (+x). Zip/upload/extract sering ngilangin
 * permission ini, jadi di-set otomatis tiap kali dipakai — gak perlu chmod manual. */
function ensureExecutable(filePath) {
  if (process.platform === 'win32') return; // Windows gak punya bit +x
  try {
    const { mode } = fs.statSync(filePath);
    const hasExecBit = (mode & 0o111) !== 0; // cek ada bit x buat owner/group/other
    if (!hasExecBit) {
      fs.chmodSync(filePath, 0o755);
      console.log(`[audio-effects] Auto chmod +x: ${filePath}`);
    }
  } catch (err) {
    // gagal chmod (misal filesystem read-only) -> biarin aja, nanti ketauan
    // pas execFileSync dicoba jalanin di bawah
    console.log(`[audio-effects] Gagal auto chmod ${filePath}: ${err.message}`);
  }
}

function detectBackend() {
  if (backend) return Promise.resolve(backend);
  if (detectPromise) return detectPromise;

  detectPromise = (async () => {
    // --- (a) Coba binary vendor hasil compile sendiri dulu (paling lengkap & terbaru) ---
    const vendored = findVendoredSox();
    if (vendored) {
      try {
        ensureExecutable(vendored); // auto chmod +x, biar gak perlu manual tiap kali extract ulang
        execFileSync(vendored, ['--version'], { stdio: 'pipe' }); // full-static, gak perlu LD_LIBRARY_PATH
        soxPath = vendored;
        soxLibDir = null;
        soxIsVendored = true;
        backend = 'sox';
        console.log(
          `[audio-effects] Backend: SoX vendored/full-static (${process.platform}/${process.arch}) — ${vendored}`
        );
        return backend;
      } catch (err) {
        console.log(
          `[audio-effects] Binary vendor ketemu tapi gagal jalan (${err.message.split('\n')[0]}), coba sox-bin...`
        );
      }
    }

    // --- (b) Coba npm package sox-bin ---
    try {
      const mod = await import('sox-bin'); // throw kalau arch/platform gak ada di daftar sox-bin
      soxPath = mod.default;
      const binDir = path.dirname(soxPath);
      const archRoot = path.join(binDir, '..'); // .../vendor/<platform>/<arch>/
      fixBrokenSymlinksInDir(archRoot);

      // folder library beda nama tergantung arch: 'lib64' (x86_64) atau 'lib' (i686/lainnya)
      soxLibDir =
        ['lib64', 'lib'].map((n) => path.join(archRoot, n)).find((p) => fs.existsSync(p)) ||
        binDir;
      soxIsVendored = false;

      execFileSync(soxPath, ['--version'], {
        env: { ...process.env, ...(process.platform === 'win32' ? {} : { LD_LIBRARY_PATH: soxLibDir }) },
        stdio: 'pipe',
      });

      backend = 'sox';
      console.log(`[audio-effects] Backend: SoX via sox-bin (${process.platform}/${process.arch})`);
      return backend;
    } catch (err) {
      console.log(
        `[audio-effects] SoX gak tersedia buat ${process.platform}/${process.arch} ` +
          `(${err.message.split('\n')[0]}), coba FFmpeg...`
      );
    }

    // --- (c) Fallback ke FFmpeg ---
    try {
      const mod = await import('ffmpeg-static');
      ffmpegPath = mod.default;
      if (!ffmpegPath || !fs.existsSync(ffmpegPath)) {
        throw new Error('ffmpeg-static binary tidak ketemu');
      }
      execFileSync(ffmpegPath, ['-version'], { stdio: 'pipe' });
      backend = 'ffmpeg';
      console.log(`[audio-effects] Backend: FFmpeg (${process.platform}/${process.arch})`);
      return backend;
    } catch (err) {
      throw new Error(
        `Gagal menemukan backend audio yang jalan di ${process.platform}/${process.arch}.\n` +
          `SoX (vendor & sox-bin) gak support arch ini, dan FFmpeg (ffmpeg-static) juga gagal dites.\n` +
          `Coba: npm install ffmpeg-static fluent-ffmpeg\n` +
          `Detail error FFmpeg: ${err.message}`
      );
    }
  })();

  return detectPromise;
}

// ===========================================================================
// 3. MENJALANKAN SoX MENTAH (kalau butuh syntax sox spesifik langsung)
// ===========================================================================
async function runSoxRaw(args) {
  const activeBackend = await detectBackend();
  if (activeBackend !== 'sox') {
    throw new Error('Backend aktif bukan SoX. Pakai addEffect() untuk kode cross-backend.');
  }
  return new Promise((resolve, reject) => {
    execFile(
      soxPath,
      args,
      { env: soxEnv() },
      (err, stdout, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve({ stdout, stderr }))
    );
  });
}

// ===========================================================================
// 4. MAPPING EFEK -> ARGUMEN SoX / FILTER FFmpeg
//    Effect object contoh:
//    { bass: 5, treble: 3, reverb: 50, echo: true, pitch: 300,
//      tempo: 1.2, speed: 0.85, volume: 1.5, fadeIn: 2, fadeOut: 2 }
//
//    Catatan penting bedanya 'tempo' vs 'speed':
//    - tempo: ubah kecepatan doang, PITCH DIPERTAHANKAN
//    - speed: ubah kecepatan DAN pitch bareng-bareng (efek "slowed" asli)
// ===========================================================================
function buildSoxArgs(effects) {
  const args = [];
  if (effects.bass !== undefined) args.push('bass', signed(effects.bass));
  if (effects.treble !== undefined) args.push('treble', signed(effects.treble));
  if (effects.volume !== undefined) args.push('vol', String(effects.volume));
  if (effects.pitch !== undefined) args.push('pitch', String(effects.pitch));
  if (effects.speed !== undefined) args.push('speed', String(effects.speed));
  if (effects.tempo !== undefined) args.push('tempo', String(effects.tempo));
  if (effects.lowpass !== undefined) args.push('lowpass', String(effects.lowpass));
  if (effects.highpass !== undefined) args.push('highpass', String(effects.highpass));
  if (effects.chorus) args.push('chorus', '0.6', '0.9', '50', '0.4', '0.25', '2', '-t');
  if (effects.flanger) args.push('flanger');
  if (effects.echo) args.push('echo', '0.8', '0.9', '60', '0.4');
  if (effects.reverb !== undefined) args.push('reverb', String(effects.reverb));
  if (effects.fadeIn !== undefined) args.push('fade', 'l', String(effects.fadeIn));
  if (effects.fadeOut !== undefined) args.push('fade', 'l', '0', '0', String(effects.fadeOut));
  return args;
}

function buildFfmpegFilters(effects, sourceRate) {
  const filters = [];
  if (effects.bass !== undefined) filters.push(`bass=g=${effects.bass}`);
  if (effects.treble !== undefined) filters.push(`treble=g=${effects.treble}`);
  if (effects.volume !== undefined) filters.push(`volume=${effects.volume}`);
  if (effects.pitch !== undefined) {
    // sox 'pitch' satuan cents (100 = 1 semitone) -> konversi ke rasio sample rate
    const ratio = Math.pow(2, effects.pitch / 1200);
    filters.push(`asetrate=${sourceRate}*${ratio.toFixed(6)}`, `aresample=${sourceRate}`);
  }
  if (effects.speed !== undefined) {
    // ubah sample rate langsung -> kecepatan & pitch turun bareng (efek "slowed")
    filters.push(`asetrate=${sourceRate}*${effects.speed}`, `aresample=${sourceRate}`);
  }
  if (effects.tempo !== undefined) filters.push(`atempo=${clampTempo(effects.tempo)}`);
  if (effects.lowpass !== undefined) filters.push(`lowpass=f=${effects.lowpass}`);
  if (effects.highpass !== undefined) filters.push(`highpass=f=${effects.highpass}`);
  if (effects.chorus) filters.push('chorus=0.6:0.9:50:0.4:0.25:2');
  if (effects.eightD) {
    // efek "8D audio" -- suara berputar/panning kiri-kanan bolak-balik.
    // Parameter ini nyocokin persis preset resmi audioalter.com/preset/8d-audio:
    // Auto Panner freq=0.08, amount=85%. SoX gak punya efek panning-oscillator,
    // jadi ini SELALU lewat FFmpeg (filter apulsator) walau backend utamanya SoX.
    filters.push(`apulsator=hz=${effects.eightDSpeed || 0.08}:amount=0.85`);
  }
  if (effects.flanger) filters.push('flanger');
  if (effects.echo) filters.push('aecho=0.8:0.9:60:0.4');
  if (effects.reverb !== undefined) {
    const depth = Math.min(Math.max(effects.reverb, 0), 100) / 100;
    filters.push(
      `aecho=0.8:0.88:${Math.round(40 + depth * 40)}|${Math.round(60 + depth * 60)}:0.4|0.3`
    );
  }
  if (effects.fadeIn !== undefined) filters.push(`afade=t=in:st=0:d=${effects.fadeIn}`);
  if (effects.fadeOut !== undefined) filters.push(`afade=t=out:d=${effects.fadeOut}`);
  return filters;
}

function signed(n) {
  return n >= 0 ? `+${n}` : `${n}`;
}

function clampTempo(t) {
  return Math.min(Math.max(t, 0.5), 2.0); // batas valid filter atempo ffmpeg
}

// ===========================================================================
// 4b. FORMAT YANG DIDUKUNG BINARY SoX YANG AKTIF
//     Dicek DINAMIS langsung dari binary yang lagi dipakai (bukan hardcode),
//     karena binary vendor (full-featured, ada mp3/flac/ogg) beda cakupannya
//     dari sox-bin (cuma format uncompressed). Kalau binary aktif gak
//     dukung suatu format, otomatis jembatani pakai FFmpeg (convert dulu ke
//     WAV, proses efeknya tetap pakai SoX, convert balik).
// ===========================================================================
let soxFormatsCache = null;

function getSoxSupportedFormats() {
  if (soxFormatsCache) return soxFormatsCache;
  try {
    const out = execFileSync(soxPath, ['--help'], {
      env: soxEnv(),
    }).toString();
    const match = out.match(/AUDIO FILE FORMATS:\s*([^\n]+)/i);
    soxFormatsCache = new Set(match ? match[1].trim().split(/\s+/) : []);
  } catch {
    soxFormatsCache = new Set(); // gagal deteksi -> anggap gak ada yang didukung, biar aman ke FFmpeg-bridge
  }
  return soxFormatsCache;
}

function getExt(filePath) {
  return path.extname(filePath).slice(1).toLowerCase();
}

function soxSupportsFormat(filePath) {
  return getSoxSupportedFormats().has(getExt(filePath));
}

/** Convert file dari satu format ke format lain pakai FFmpeg, tanpa filter apapun
 * (cuma buat jembatan codec, misal mp3 <-> wav), kualitas dijaga maksimal. */
async function convertWithFfmpeg(input, output) {
  if (!ffmpegPath) {
    const mod = await import('ffmpeg-static');
    ffmpegPath = mod.default;
  }
  const { default: ffmpegFactory } = await import('fluent-ffmpeg');
  ffmpegFactory.setFfmpegPath(ffmpegPath);
  return new Promise((resolve, reject) => {
    let cmd = ffmpegFactory(input);
    if (getExt(output) === 'wav') {
      cmd = cmd.audioCodec('pcm_s24le'); // WAV: PCM biar lossless, gak ada codec loss tambahan
    }
    cmd.on('error', reject).on('end', resolve).save(output);
  });
}

/**
 * Deteksi sample rate file input. Dibutuhin backend FFmpeg biar filter
 * asetrate (buat speed/pitch) dihitung dari rate asli, bukan asumsi 44100.
 */
function getSampleRate(input) {
  try {
    if (backend === 'sox') {
      const out = execFileSync(soxPath, ['--i', '-r', input], {
        env: soxEnv(),
      })
        .toString()
        .trim();
      const rate = parseInt(out, 10);
      if (rate) return rate;
    } else {
      execFileSync(ffmpegPath, ['-i', input], { stdio: ['ignore', 'pipe', 'pipe'] });
    }
  } catch (err) {
    // ffmpeg -i selalu exit non-zero walau berhasil baca info filenya,
    // jadi info sample rate diambil dari stderr yang nempel di error object
    const text = (err.stderr || err.stdout || '').toString();
    const match = text.match(/(\d+)\s*Hz/);
    if (match) return parseInt(match[1], 10);
  }
  return 44100; // fallback aman kalau deteksi gagal
}

// ===========================================================================
// 5. API UTAMA
// ===========================================================================

/**
 * Tambahkan efek ke file audio, otomatis pakai backend yang tersedia.
 * Kalau backend SoX dipakai tapi format input/output-nya gak didukung
 * (misal mp3), otomatis convert ke WAV dulu pakai FFmpeg, proses efeknya
 * pakai SoX, lalu convert balik ke format aslinya.
 *
 * KHUSUS efek 8D (effects.eightD): ini SELALU butuh pass tambahan lewat
 * FFmpeg (filter apulsator), apapun backend utamanya -- karena SoX gak
 * punya efek panning-oscillator. Kalau backend utama SoX, efek lain (bass,
 * reverb, dst) tetap diproses SoX dulu ke file sementara, baru pass 8D-nya
 * ditambahin di atas hasil itu lewat FFmpeg. Butuh `ffmpeg-static` +
 * `fluent-ffmpeg` ter-install (npm install ffmpeg-static fluent-ffmpeg).
 *
 * @param {string} input - path file input (mp3, wav, ogg, flac, dll)
 * @param {string} output - path file output (format ditentukan dari ekstensi)
 * @param {object} effects - lihat komentar di buildSoxArgs di atas
 */
async function addEffect(input, output, effects) {
  const activeBackend = await detectBackend();

  // Preset 8D (sesuai audioalter.com/preset/8d-audio) SELALU dibarengi reverb
  // default SoX, kecuali user udah nentuin reverb sendiri secara eksplisit.
  // Berlaku di semua jalur backend (SoX ataupun FFmpeg full-fallback).
  if (effects.eightD && effects.reverb === undefined) {
    effects = { ...effects, reverb: 50 };
  }

  // --- Efek 8D butuh FFmpeg apapun backend utamanya (SoX gak bisa panning) ---
  if (effects.eightD && activeBackend === 'sox') {
    const { eightD, eightDSpeed, ...otherEffects } = effects;
    const hasOtherEffects = Object.keys(otherEffects).length > 0;

    if (!hasOtherEffects) {
      // gak ada efek lain -> langsung satu pass FFmpeg apulsator ke output final
      return applyEightDOnly(input, output, eightDSpeed);
    }

    // ada efek lain juga -> proses dulu pakai SoX (kualitas terbaik) ke WAV
    // sementara, baru pass ke-2 nambahin panning 8D lewat FFmpeg ke output final
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-effects-8d-'));
    const tmpWav = path.join(tmpDir, 'stage1.wav');
    try {
      console.log('[audio-effects] Proses efek non-8D pakai SoX dulu...');
      await addEffect(input, tmpWav, otherEffects); // rekursif, tanpa eightD -> lewat jalur SoX normal
      console.log('[audio-effects] Nambahin panning 8D pakai FFmpeg (apulsator)...');
      await applyEightDOnly(tmpWav, output, eightDSpeed);
      return { backend: 'sox+ffmpeg-8d' };
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  if (activeBackend === 'sox') {
    const inputOk = soxSupportsFormat(input);
    const outputOk = soxSupportsFormat(output);

    if (inputOk && outputOk) {
      // fast path: format didukung native sama SoX, gak perlu konversi apapun
      const args = buildSoxArgs(effects);
      return runSoxRaw([input, output, ...args]);
    }

    // hybrid path: mp3/flac/ogg/dll -> convert ke WAV -> proses SoX -> convert balik
    console.log(
      `[audio-effects] Format .${getExt(input) || getExt(output)} gak didukung SoX bundled, ` +
        `pakai FFmpeg buat konversi container (efek tetap diproses SoX)...`
    );

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-effects-'));
    const tmpInput = inputOk ? input : path.join(tmpDir, 'in.wav');
    const tmpOutput = outputOk ? output : path.join(tmpDir, 'out.wav');

    try {
      if (!inputOk) await convertWithFfmpeg(input, tmpInput);
      const args = buildSoxArgs(effects);
      await runSoxRaw([tmpInput, tmpOutput, ...args]);
      if (!outputOk) await convertWithFfmpeg(tmpOutput, output);
      return { backend: 'sox+ffmpeg-bridge' };
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  // backend === 'ffmpeg' (arch gak didukung sox-bin sama sekali)
  // -> efek 8D otomatis kepasang di sini juga (lihat buildFfmpegFilters),
  //    gak perlu pass terpisah karena semuanya udah lewat FFmpeg
  const { default: ffmpegFactory } = await import('fluent-ffmpeg');
  ffmpegFactory.setFfmpegPath(ffmpegPath);
  const needsRate = effects.pitch !== undefined || effects.speed !== undefined;
  const sourceRate = needsRate ? getSampleRate(input) : 44100;
  const filters = buildFfmpegFilters(effects, sourceRate);

  return new Promise((resolve, reject) => {
    let cmd = ffmpegFactory(input);
    if (filters.length) cmd = cmd.audioFilters(filters);
    cmd
      .on('error', (err) => reject(err))
      .on('end', () => resolve({ backend: 'ffmpeg', filters }))
      .save(output);
  });
}

/** Pass FFmpeg khusus buat nambahin panning 8D (filter apulsator) doang,
 * gak nyentuh efek lain. Dipakai dari addEffect() di atas. */
async function applyEightDOnly(input, output, speedHz) {
  if (!ffmpegPath) {
    let mod;
    try {
      mod = await import('ffmpeg-static');
    } catch {
      throw new Error(
        "Efek 8D butuh package 'ffmpeg-static' & 'fluent-ffmpeg'. " +
          'Install dulu: npm install ffmpeg-static fluent-ffmpeg'
      );
    }
    ffmpegPath = mod.default;
  }
  const { default: ffmpegFactory } = await import('fluent-ffmpeg');
  ffmpegFactory.setFfmpegPath(ffmpegPath);
  return new Promise((resolve, reject) => {
    ffmpegFactory(input)
      .audioFilters(`apulsator=hz=${speedHz || 0.08}:amount=0.85`)
      .on('error', reject)
      .on('end', resolve)
      .save(output);
  });
}

/**
 * Preset "slowed + reverb" — nyocokin persis settingan preset resmi
 * audioalter.com/preset/slowed-reverb (dicek langsung: default reverb SoX
 * itu reverberance 50%, HF-damping 50%, room-scale 100%, stereo-depth 100%,
 * pre-delay 0ms, wet-gain 0dB — persis default polos SoX, gak ada modifikasi).
 * Pakai 'speed' (bukan 'tempo') karena preset itu "Preserve pitch: false",
 * artinya pitch ikut turun bareng kecepatan.
 *
 * @param {string} input
 * @param {string} output
 * @param {object} [opts]
 * @param {number} [opts.speed=0.85] - sama kayak "Tempo: 0.85x" di audioalter
 * @param {number} [opts.reverb=50] - default SoX reverb (= default audioalter)
 * @param {number} [opts.bass] - opsional, gak dipakai di preset asli audioalter
 */
async function slowedReverb(input, output, opts = {}) {
  const { speed = 0.85, reverb = 50, bass } = opts;
  const effects = { speed, reverb };
  if (bass !== undefined) effects.bass = bass;
  return addEffect(input, output, effects);
}

// ===========================================================================
// 6. CLI — jalan kalau file ini dieksekusi langsung (bukan di-import)
//    Semua parameter efek yang ada di fungsi addEffect() (lihat bagian 4)
//    kepasang sebagai flag CLI di sini, plus --raw buat akses langsung ke
//    sintaks efek SoX apapun tanpa perlu edit kode ini lagi.
// ===========================================================================

// key: nama flag CLI | value: nama key di object 'effects'
const NUMERIC_FLAGS = {
  speed: 'speed',
  tempo: 'tempo',
  pitch: 'pitch',
  bass: 'bass',
  treble: 'treble',
  volume: 'volume',
  reverb: 'reverb',
  lowpass: 'lowpass',
  highpass: 'highpass',
  fadein: 'fadeIn',
  fadeout: 'fadeOut',
  '8dspeed': 'eightDSpeed',
};
const BOOLEAN_FLAGS = {
  echo: 'echo',
  chorus: 'chorus',
  flanger: 'flanger',
  '8d': 'eightD',
};

function parseCliArgs(argv) {
  const positional = [];
  const options = {};
  for (const arg of argv) {
    if (arg.startsWith('--')) {
      const eqIdx = arg.indexOf('='); // pakai indexOf, bukan split('='), biar --raw="a=b" gak kepotong
      if (eqIdx === -1) {
        options[arg.slice(2)] = true;
      } else {
        options[arg.slice(2, eqIdx)] = arg.slice(eqIdx + 1);
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, options };
}

function printUsage() {
  console.log(`
Pemakaian:
  node slowed-reverb.mjs <input> <output> [opsi]

Tanpa opsi apapun -> otomatis pakai preset "slowed + reverb"
(speed=0.85, reverb=50, sesuai preset audioalter.com).
Begitu kamu kasih SATU flag apapun di bawah, preset default itu OFF
total -- cuma efek yang kamu sebutkan aja yang jalan.

Opsi angka (--nama=nilai):
  --speed=N       kecepatan + pitch turun/naik bareng (mis. 0.85 lambat, 1.25 cepat)
  --tempo=N       kecepatan doang, PITCH TETAP (0.5 - 2.0)
  --pitch=N       naik/turun nada dalam cents (100 = 1 semitone, boleh negatif)
  --bass=N        boost/cut bass dalam dB (boleh negatif)
  --treble=N      boost/cut treble dalam dB (boleh negatif)
  --volume=N      kelipatan volume (1 = normal, 1.5 = lebih keras, 0.5 = pelan)
  --reverb=N      kedalaman reverb 0-100
  --lowpass=N     buang frekuensi di atas N Hz (efek "underwater"/teredam)
  --highpass=N    buang frekuensi di bawah N Hz (efek "telepon"/radio, coba highpass=300)
  --fadein=N      fade in N detik di awal
  --fadeout=N     fade out N detik di akhir

Opsi on/off (--nama, gak perlu nilai):
  --echo          efek echo/gema
  --chorus        efek chorus ("paduan suara")
  --flanger       efek flanger (whoosh/jet)
  --8d            efek 8D audio (suara berputar kiri-kanan, pakai headphone!)
                  -- SELALU lewat FFmpeg apapun backend lainnya, butuh
                  npm install ffmpeg-static fluent-ffmpeg kalau belum ada.
                  Atur kecepatan puterannya pakai --8dspeed=N (Hz, default 0.2)

Jalan pintas SoX mentah (BACKEND HARUS SoX, gak jalan di mode fallback FFmpeg):
  --raw="..."     tulis efek SoX manual apapun, contoh:
                  --raw="bass +10 reverb 80 chorus 0.6 0.9 50 0.4 0.25 2 -t"
                  Ini bypass semua flag di atas -- gunain ini kalau butuh efek
                  SoX yang belum ada nama flag-nya (lihat: man sox, bagian EFFECTS).

Contoh:
  node slowed-reverb.mjs lagu.mp3 hasil.mp3
  node slowed-reverb.mjs lagu.mp3 hasil.mp3 --speed=1.25 --reverb=0
  node slowed-reverb.mjs lagu.mp3 hasil.mp3 --highpass=300 --lowpass=3400 --bass=-5
  node slowed-reverb.mjs lagu.mp3 hasil.mp3 --lowpass=500 --reverb=30
  node slowed-reverb.mjs lagu.mp3 hasil.mp3 --chorus --echo --pitch=-200
  node slowed-reverb.mjs lagu.mp3 hasil.mp3 --8d
  node slowed-reverb.mjs lagu.mp3 hasil.mp3 --8d --8dspeed=0.3 --bass=8
  node slowed-reverb.mjs lagu.mp3 hasil.mp3 --raw="phaser 0.8 0.74 3 0.4 0.5 -t"
`);
}

async function runCli() {
  const { positional, options } = parseCliArgs(process.argv.slice(2));
  const [input, output] = positional;

  if (!input || !output || options.help || options.h) {
    printUsage();
    process.exit(options.help || options.h ? 0 : 1);
  }
  if (!fs.existsSync(input)) {
    console.error(`Error: file input tidak ditemukan: ${input}`);
    process.exit(1);
  }

  // --- Jalur --raw: bypass semua flag lain, langsung ke sintaks SoX mentah ---
  if (options.raw !== undefined) {
    const activeBackend = await detectBackend();
    if (activeBackend !== 'sox') {
      console.error(
        `Error: --raw butuh backend SoX, tapi backend aktif sekarang '${activeBackend}'.\n` +
          `Cek koneksi/arch server kamu, atau pastikan folder vendor/ atau sox-bin kedetect.`
      );
      process.exit(1);
    }
    const rawArgs = String(options.raw).trim().split(/\s+/);
    console.log(`Memproses "${input}" -> "${output}" pakai --raw:`, rawArgs.join(' '));

    // Format input/output tetap dijembatani ke WAV dulu kalau perlu (mis. mp3
    // di sox-bin lama yang gak native), tapi kalau vendor/full-featured
    // dipakai, ini bakal langsung native tanpa bridge.
    const inputOk = soxSupportsFormat(input);
    const outputOk = soxSupportsFormat(output);
    if (inputOk && outputOk) {
      try {
        await runSoxRaw([input, output, ...rawArgs]);
        console.log(`Selesai (raw)! Backend: ${backend}`);
        console.log(`Output tersimpan di: ${path.resolve(output)}`);
      } catch (err) {
        console.error('Gagal memproses audio (raw):', err.message);
        process.exit(1);
      }
      return;
    }
    // format gak didukung native -> jembatani manual pakai FFmpeg (mp3, dll)
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-effects-raw-'));
    const tmpInput = inputOk ? input : path.join(tmpDir, 'in.wav');
    const tmpOutput = outputOk ? output : path.join(tmpDir, 'out.wav');
    try {
      if (!inputOk) await convertWithFfmpeg(input, tmpInput);
      await runSoxRaw([tmpInput, tmpOutput, ...rawArgs]);
      if (!outputOk) await convertWithFfmpeg(tmpOutput, output);
      console.log(`Selesai (raw, via jembatan FFmpeg buat container)! Backend: ${backend}`);
      console.log(`Output tersimpan di: ${path.resolve(output)}`);
    } catch (err) {
      console.error('Gagal memproses audio (raw):', err.message);
      process.exit(1);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
    return;
  }

  // --- Jalur normal: kumpulin semua flag yang dikasih ke object effects ---
  const effects = {};
  let anyFlagGiven = false;
  for (const [flag, key] of Object.entries(NUMERIC_FLAGS)) {
    if (options[flag] !== undefined) {
      effects[key] = parseFloat(options[flag]);
      anyFlagGiven = true;
    }
  }
  for (const [flag, key] of Object.entries(BOOLEAN_FLAGS)) {
    if (options[flag] !== undefined) {
      effects[key] = true;
      anyFlagGiven = true;
    }
  }

  // Gak ada flag sama sekali -> fallback ke preset default "slowed + reverb"
  if (!anyFlagGiven) {
    effects.speed = 0.85;
    effects.reverb = 50;
  }

  console.log(`Memproses "${input}" -> "${output}" dengan opsi:`, effects);

  try {
    await addEffect(input, output, effects);
    console.log(`Selesai! Backend yang dipakai: ${backend}`);
    console.log(`Output tersimpan di: ${path.resolve(output)}`);
  } catch (err) {
    console.error('Gagal memproses audio:', err.message);
    process.exit(1);
  }
}

// Deteksi "apakah file ini dijalankan langsung" versi ESM
const isMain = process.argv[1] && import.meta.url === `file://${path.resolve(process.argv[1])}`;
if (isMain) {
  runCli();
}

export { addEffect, slowedReverb, runSoxRaw, detectBackend };
export const getBackend = () => backend;
