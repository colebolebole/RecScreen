'use strict';
const {
  app, BrowserWindow, ipcMain, desktopCapturer, session, dialog,
  globalShortcut, shell, screen, Menu, safeStorage, net: electronNet,
} = require('electron');
const net = require('net');
const { overlayFor } = require('./taskbar');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const FFMPEG = require('./ffmpeg-builds');
const { installBuild, isInstalled } = require('./ffmpeg-setup');

const SELFTEST = process.argv.includes('--selftest');

// Keep rendering / timers alive while the window is minimised or covered —
// essential for a recorder that composites in the renderer.
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('enable-features', 'WebRtcHideLocalIpsWithMdns');

if (!app.requestSingleInstanceLock() && !SELFTEST) {
  app.quit();
}

let win = null;
const recs = new Map(); // id -> { stream, path, bytes, start }
let recSeq = 0;

/* ffmpeg is downloaded on first launch into <userData>/ffmpeg/<version> (see ffmpeg-builds.js). When running
   from source, vendor/ffmpeg(-legacy) from `npm run ffmpeg` is used if the app hasn't downloaded its own copy. */
const IS_WIN = process.platform === 'win32';
const ffDir = (which) => path.join(app.getPath('userData'), 'ffmpeg', FFMPEG[which].version);

/* Linux / macOS: the pinned builds are Windows binaries, so use the system's ffmpeg instead
   (VELOCITY_FFMPEG=/path/to/ffmpeg overrides the lookup). There is no legacy build there. */
let systemFfmpegCache = null;
function systemFfmpeg() {
  if (systemFfmpegCache && fs.existsSync(systemFfmpegCache)) return systemFfmpegCache;
  const dirs = (process.env.PATH || '').split(path.delimiter)
    .concat(['/usr/bin', '/usr/local/bin', '/opt/homebrew/bin', '/snap/bin', '/var/lib/flatpak/exports/bin']);
  const cands = [process.env.VELOCITY_FFMPEG, ...dirs.filter(Boolean).map((d) => path.join(d, 'ffmpeg'))];
  for (const c of cands) {
    try { if (c) { fs.accessSync(c, fs.constants.X_OK); if (fs.statSync(c).isFile()) return (systemFfmpegCache = c); } } catch { /* next */ }
  }
  return (systemFfmpegCache = null);
}

function ffExe(which) {
  if (!IS_WIN) return which === 'main' ? systemFfmpeg() : null;
  if (isInstalled(FFMPEG[which], ffDir(which))) return path.join(ffDir(which), 'ffmpeg.exe');
  if (!app.isPackaged) {
    const dev = path.join(__dirname, 'vendor', which === 'main' ? 'ffmpeg' : 'ffmpeg-legacy', 'ffmpeg.exe');
    if (fs.existsSync(dev)) return dev;
  }
  return null;
}
/** The main ffmpeg (muxing, screenshots, post-processing, and every encoder that works on it). */
const ffmpegPath = () => ffExe('main');

function defaultRecDir() {
  try { return path.join(app.getPath('videos'), 'Velocity Studio'); }
  catch { return path.join(os.homedir(), 'Videos', 'Velocity Studio'); }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 880,
    minWidth: 1080,
    minHeight: 680,
    show: false,
    backgroundColor: '#04090b',
    title: 'Velocity Studio',
    icon: path.join(__dirname, 'src', 'icon.png'),
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#04090b', symbolColor: '#b9d3db', height: 40 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      autoplayPolicy: 'no-user-gesture-required',
    },
  });
  Menu.setApplicationMenu(null);
  win.loadFile(path.join(__dirname, 'src', 'index.html'));
  win.once('ready-to-show', () => win.show());
  // If a recording is running, let the renderer finalise the file before the window goes away.
  win.on('close', (e) => {
    if (busy && !forceQuit) { e.preventDefault(); win.webContents.send('request-close'); }
  });
  win.on('closed', () => { win = null; });
}

app.whenReady().then(() => {
  // Allow camera / microphone / capture without prompting.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => {
    cb(['media', 'display-capture', 'audioCapture', 'videoCapture', 'fullscreen'].includes(permission));
  });
  session.defaultSession.setPermissionCheckHandler(() => true);
  createWindow();
});

app.on('second-instance', () => {
  if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
});
app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  for (const r of recs.values()) { try { r.stream.end(); } catch { /* ignore */ } }
  for (const s of streams.values()) { try { s.closed = true; if (s.proc) s.proc.kill(); } catch { /* ignore */ } }
});

/* ------------------------------------------------------------------ */
/* App info                                                            */
/* ------------------------------------------------------------------ */
ipcMain.handle('app:info', () => ({
  version: app.getVersion(),
  defaultRecDir: defaultRecDir(),
  ffmpeg: !!ffmpegPath(),
  selftest: SELFTEST,
  outDir: SELFTEST && process.env.VELOCITY_OUT ? process.env.VELOCITY_OUT : null,
  cores: os.cpus().length,
  platform: process.platform,
}));

/* ------------------------------------------------------------------ */
/* Capture source enumeration                                          */
/* ------------------------------------------------------------------ */
ipcMain.handle('sources:list', async (_e, opts = {}) => {
  const types = opts.types || ['screen', 'window'];
  const w = opts.thumb || 320;
  const sources = await desktopCapturer.getSources({
    types,
    thumbnailSize: { width: w, height: Math.round(w * 9 / 16) },
    fetchWindowIcons: true,
  });
  const displays = screen.getAllDisplays();
  const primaryId = screen.getPrimaryDisplay().id;
  const ownId = win ? win.getMediaSourceId() : null;
  let screenIdx = 0;
  const out = [];
  for (const s of sources) {
    if (s.id === ownId) continue;
    const isScreen = s.id.startsWith('screen:');
    let name = s.name;
    let meta = '';
    if (isScreen) {
      screenIdx += 1;
      const d = displays.find((x) => String(x.id) === String(s.display_id));
      if (d) {
        const pw = Math.round(d.size.width * d.scaleFactor);
        const ph = Math.round(d.size.height * d.scaleFactor);
        name = `Display ${screenIdx}`;
        meta = `${pw}×${ph} @ ${d.bounds.x},${d.bounds.y}${d.id === primaryId ? ' · Primary' : ''}`;
      }
    } else if (!s.name || !s.name.trim()) {
      continue;
    }
    out.push({
      id: s.id,
      type: isScreen ? 'screen' : 'window',
      name,
      meta,
      thumb: s.thumbnail && !s.thumbnail.isEmpty() ? s.thumbnail.toDataURL() : '',
      icon: s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.toDataURL() : '',
    });
  }
  return out;
});

/* ------------------------------------------------------------------ */
/* Files & dialogs                                                     */
/* ------------------------------------------------------------------ */
ipcMain.handle('dialog:folder', async (_e, current) => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'], defaultPath: current || undefined });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('dialog:image', async () => {
  const r = await dialog.showOpenDialog(win, {
    properties: ['openFile'],
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'svg'] }],
  });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('file:read', async (_e, p) => {
  const buf = await fs.promises.readFile(p);
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
});
ipcMain.handle('shell:show', (_e, p) => { if (p && fs.existsSync(p)) shell.showItemInFolder(p); });
ipcMain.handle('shell:openDir', async (_e, p) => {
  try { await fs.promises.mkdir(p, { recursive: true }); } catch { /* ignore */ }
  return shell.openPath(p);
});
ipcMain.handle('shell:openFile', (_e, p) => shell.openPath(p));

ipcMain.handle('shot:save', async (_e, { dir, name, data }) => {
  await fs.promises.mkdir(dir, { recursive: true });
  const file = uniquePath(path.join(dir, name));
  await fs.promises.writeFile(file, Buffer.from(data));
  return file;
});

function uniquePath(p) {
  if (!fs.existsSync(p)) return p;
  const { dir, name, ext } = path.parse(p);
  for (let i = 2; i < 10000; i++) {
    const c = path.join(dir, `${name} (${i})${ext}`);
    if (!fs.existsSync(c)) return c;
  }
  return p;
}

/* ------------------------------------------------------------------ */
/* Recording sink                                                      */
/* ------------------------------------------------------------------ */
ipcMain.handle('rec:open', async (_e, { dir, name, ext }) => {
  await fs.promises.mkdir(dir, { recursive: true });
  const safe = name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim() || 'recording';
  const file = uniquePath(path.join(dir, `${safe}.${ext}`));
  const stream = fs.createWriteStream(file);
  const id = ++recSeq;
  const entry = { stream, path: file, bytes: 0, error: null };
  stream.on('error', (err) => { entry.error = err; });
  recs.set(id, entry);
  return { id, path: file };
});

ipcMain.on('rec:write', (_e, id, data) => {
  const r = recs.get(id);
  if (!r || r.error) return;
  const buf = Buffer.from(data);
  r.bytes += buf.length;
  r.stream.write(buf);
});

ipcMain.handle('rec:size', (_e, id) => (recs.get(id) ? recs.get(id).bytes : 0));

ipcMain.handle('rec:close', async (_e, id, opts = {}) => {
  const r = recs.get(id);
  if (!r) return { ok: false, error: 'Unknown recording' };
  await new Promise((resolve) => r.stream.end(resolve));
  recs.delete(id);
  if (r.error) return { ok: false, error: String(r.error.message || r.error), path: r.path };

  const nativeExt = path.extname(r.path).slice(1).toLowerCase();
  const target = (opts.target || nativeExt).toLowerCase();
  const needsProcess = nativeExt !== target || (nativeExt === 'webm' && opts.fixDuration !== false);
  if (!needsProcess) return { ok: true, path: r.path, bytes: r.bytes };

  const ff = ffmpegPath();
  if (!ff) return { ok: true, path: r.path, bytes: r.bytes, warning: 'ffmpeg not available — saved in the native format.' };

  const finalPath = nativeExt === target ? r.path : uniquePath(r.path.replace(/\.[^.]+$/, `.${target}`));
  const out = r.path.replace(/\.[^.]+$/, `.processing.${target}`);
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-fflags', '+genpts', '-i', r.path];
  const aBr = `${opts.audioBitrate || 192}k`;
  if (target === 'mp4') {
    if (opts.codec === 'h264') args.push('-c:v', 'copy');
    else args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '19', '-pix_fmt', 'yuv420p');
    args.push('-c:a', 'aac', '-b:a', aBr, '-movflags', '+faststart');
  } else {
    args.push('-c', 'copy');
  }
  args.push('-progress', 'pipe:1', out);

  const durMs = Math.max(1, opts.durationMs || 1);
  const result = await new Promise((resolve) => {
    const p = spawn(ff, args, { windowsHide: true });
    let errTxt = '';
    p.stderr.on('data', (d) => { errTxt += d.toString(); });
    let buf = '';
    p.stdout.on('data', (d) => {
      buf += d.toString();
      const m = [...buf.matchAll(/out_time_(?:us|ms)=(\d+)/g)].pop();
      if (m && win) {
        const pct = Math.min(99, Math.round((Number(m[1]) / 1000) / durMs * 100));
        win.webContents.send('rec:progress', { id, pct });
      }
      if (buf.length > 4096) buf = buf.slice(-1024);
    });
    p.on('error', (err) => resolve({ ok: false, error: err.message }));
    p.on('close', (code) => resolve(code === 0 ? { ok: true } : { ok: false, error: errTxt.trim().split('\n').pop() || `ffmpeg exited with ${code}` }));
  });

  if (result.ok && fs.existsSync(out)) {
    try { await fs.promises.unlink(r.path); } catch { /* keep both if we cannot delete */ }
    let done = out;
    try { await fs.promises.rename(out, finalPath); done = finalPath; } catch { /* keep .processing name */ }
    const st = await fs.promises.stat(done);
    return { ok: true, path: done, bytes: st.size };
  }
  try { if (fs.existsSync(out)) await fs.promises.unlink(out); } catch { /* ignore */ }
  return { ok: true, path: r.path, bytes: r.bytes, warning: `Post-processing failed (${result.error}). Original kept.` };
});

/* ------------------------------------------------------------------ */
/* Encoding via ffmpeg (NVENC / AMF / Quick Sync / x264 / x265)       */
/*                                                                     */
/* The renderer composites the scene, converts it to NV12 on the GPU    */
/* and streams raw frames here. They are piped into ffmpeg's encoder, */
/* the mixed audio arrives as a separate Opus file; both are muxed into */
/* the final container when recording stops.                           */
/* ------------------------------------------------------------------ */
// Tag frames as BT.709 limited range (what nv12.js produces). Setting it on the frames, rather than only via
// -color_primaries / -color_trc, is what makes every encoder write it: ffmpeg 9 no longer passes those output
// options through to the H.264 encoders.
const BT709 = 'setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv';
const BT709_FLAGS = ['-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv'];

const encs = new Map(); // id -> session
let encSeq = 0;
let probeCache = null;

function runFfmpegProbe(ff, codec) {
  return new Promise((resolve) => {
    const p = spawn(ff, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=1280x720:r=30', '-frames:v', '3', '-c:v', codec, '-f', 'null', '-'], { windowsHide: true });
    const t = setTimeout(() => { try { p.kill(); } catch { /* ignore */ } resolve(false); }, 10000);
    p.on('error', () => { clearTimeout(t); resolve(false); });
    p.on('close', (code) => { clearTimeout(t); resolve(code === 0); });
  });
}

// Every encoder the UI can offer. Hardware ones only initialise on a matching GPU, so each is probed with a
// tiny test encode; failures return instantly, so probing them all in parallel costs well under a second.
const PROBE_CODECS = [
  'h264_nvenc', 'hevc_nvenc', 'av1_nvenc',
  'h264_amf', 'hevc_amf', 'av1_amf',
  'h264_qsv', 'hevc_qsv', 'av1_qsv',
  'libx264', 'libx265',
];

ipcMain.handle('enc:probe', async () => probe());

/**
 * Which encoders start, and on which build. Each codec is tried on the main build first; any that fail there are
 * retried on the legacy build (if downloaded) and, if that works, routed to it from then on (see ffFor()).
 */
async function probe() {
  if (probeCache) return probeCache;
  const main = ffmpegPath();
  const legacy = ffExe('legacy');
  const enc = Object.fromEntries(PROBE_CODECS.map((c) => [c, false]));
  const bin = {};
  if (main) {
    const ok = await Promise.all(PROBE_CODECS.map((c) => runFfmpegProbe(main, c)));
    PROBE_CODECS.forEach((c, i) => { enc[c] = ok[i]; });
    if (legacy) {
      const retry = PROBE_CODECS.filter((c) => !enc[c]);
      const ok2 = await Promise.all(retry.map((c) => runFfmpegProbe(legacy, c)));
      retry.forEach((c, i) => { if (ok2[i]) { enc[c] = true; bin[c] = 'legacy'; } });
    }
  }
  probeCache = {
    enc,
    legacy: Object.keys(bin), // codecs that run on the legacy build
    nvenc: { h264: enc.h264_nvenc, hevc: enc.hevc_nvenc, av1: enc.av1_nvenc },
    amf: { h264: enc.h264_amf, hevc: enc.hevc_amf, av1: enc.av1_amf },
  };
  return probeCache;
}

/** ffmpeg binary to encode with a given codec. */
function ffFor(ffCodec) {
  if (probeCache && probeCache.legacy.includes(ffCodec)) return ffExe('legacy') || ffmpegPath();
  return ffmpegPath();
}

/* ---- First-launch download (ffmpeg-setup.js) ---- */
let ffInstall = null; // { which, ctrl }

ipcMain.handle('ffmpeg:status', () => ({
  main: !!ffmpegPath(),
  legacy: !!ffExe('legacy'),
  managed: IS_WIN, // false: the app doesn't download ffmpeg, it uses the one installed on the system
  builds: Object.fromEntries(Object.entries(FFMPEG).map(([k, b]) => [k, { version: b.version, label: b.label, size: b.size }])),
}));

ipcMain.handle('ffmpeg:install', async (_e, which) => {
  if (!FFMPEG[which]) return { ok: false, error: 'Unknown build.' };
  if (!IS_WIN) return { ok: false, error: 'Install ffmpeg with your package manager (for example: sudo apt install ffmpeg), then restart Velocity Studio.' };
  if (ffInstall) return { ok: false, error: 'A download is already running.' };
  const ctrl = new AbortController();
  ffInstall = { which, ctrl };
  const send = (d) => { if (win) win.webContents.send('ffmpeg:progress', { which, ...d }); };
  try {
    await installBuild(FFMPEG[which], ffDir(which), {
      fetchImpl: (url, opts) => electronNet.fetch(url, opts), // Chromium networking: honours system proxy settings
      signal: ctrl.signal,
      onPhase: (phase, info = {}) => send({ phase, ...info }),
    });
    probeCache = null; // re-probe with the new build
    return { ok: true };
  } catch (err) {
    return { ok: false, cancelled: !!err.cancelled, error: err.cancelled ? 'Cancelled.' : (err.message || String(err)) };
  } finally {
    ffInstall = null;
  }
});

ipcMain.handle('ffmpeg:cancel', () => { if (ffInstall) ffInstall.ctrl.abort(); return true; });

// Only the compatibility build can be removed (done when it turned out not to rescue any encoder).
ipcMain.handle('ffmpeg:remove', (_e, which) => {
  if (which !== 'legacy' || ffInstall) return false;
  try { fs.rmSync(ffDir('legacy'), { recursive: true, force: true }); } catch { return false; }
  probeCache = null;
  return true;
});

/* ---- Share compression: two-pass x264 aimed just under a target size ---- */
let compressJob = null; // { id, proc, cancelled, out, log }

function probeDuration(ff, input) {
  return new Promise((resolve) => {
    const p = spawn(ff, ['-hide_banner', '-i', input], { windowsHide: true });
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', () => resolve(0));
    p.on('close', () => {
      const m = err.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
      resolve(m ? (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]) : 0);
    });
  });
}

ipcMain.handle('compress:start', async (_e, o) => {
  if (compressJob) return { ok: false, error: 'A compression is already running.' };
  const ff = ffmpegPath();
  if (!ff) return { ok: false, error: 'ffmpeg is not installed. Download it in Settings → Output.' };
  const { input, targetMB, id } = o;
  let bytes = 0;
  try { bytes = fs.statSync(input).size; } catch { return { ok: false, error: 'The recording file is gone.' }; }
  const limit = targetMB * 1048576;
  if (bytes <= limit) return { ok: true, already: true, path: input, bytes };
  const duration = await probeDuration(ff, input);
  if (!duration) return { ok: false, error: 'Could not read the recording duration.' };

  const audioKbps = 128;
  // 96% of the target leaves room for container overhead; audio gets a fixed slice.
  const videoKbps = Math.max(120, Math.floor((limit * 8 * 0.96) / duration / 1000 - audioKbps));
  // Low bitrates look better (and encode much faster) at 720p30 than at a starved 1080p60.
  const scale = videoKbps < 1800 ? ['-vf', 'scale=-2:720', '-r', '30'] : [];
  const base = input.replace(/\.[^.]+$/, '');
  let out = `${base}.compressed-${targetMB}mb.mp4`;
  for (let i = 2; fs.existsSync(out); i++) out = `${base}.compressed-${targetMB}mb-${i}.mp4`;
  const log = path.join(os.tmpdir(), `velocity-compress-${id}`);
  const job = { id, cancelled: false, out, log, proc: null };
  compressJob = job;

  const runPass = (pass, dest) => new Promise((resolve) => {
    const args = ['-y', '-i', input, '-c:v', 'libx264', '-preset', 'veryfast', '-b:v', `${videoKbps}k`,
      '-pass', String(pass), '-passlogfile', log, '-sn', '-dn',
      ...(pass === 2 ? [...scale, '-c:a', 'aac', '-b:a', `${audioKbps}k`, '-movflags', '+faststart'] : ['-an']),
      '-f', pass === 1 ? 'null' : 'mp4', dest, '-progress', 'pipe:1', '-nostats', '-loglevel', 'error'];
    const p = spawn(ff, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    job.proc = p;
    let errTail = '', buf = '';
    p.stderr.on('data', (d) => { errTail = (errTail + d).slice(-600); });
    p.stdout.on('data', (d) => {
      buf = (buf + d).slice(-400);
      const ms = [...buf.matchAll(/out_time_(?:us|ms)=(\d+)/g)];
      if (ms.length) {
        const frac = Math.min(1, Number(ms[ms.length - 1][1]) / 1e6 / duration);
        const pct = pass === 1 ? frac * 0.45 : 0.45 + frac * 0.55;
        if (win && !win.isDestroyed()) win.webContents.send('compress:progress', { id, pct, phase: pass });
      }
    });
    p.on('error', (e) => resolve({ ok: false, error: String(e.message || e) }));
    p.on('close', (code) => resolve(code === 0 ? { ok: true } : {
      ok: false,
      error: job.cancelled ? 'cancelled' : (errTail.trim().split('\n').pop() || `ffmpeg exited with ${code}`),
    }));
  });

  const cleanup = () => {
    for (const f of [log, `${log}-0.log`, `${log}.log`]) try { fs.unlinkSync(f); } catch { /* next */ }
    if (!job.cancelled) return;
    try { fs.unlinkSync(out); } catch { /* partial output */ }
  };
  const r1 = await runPass(1, IS_WIN ? 'NUL' : '/dev/null');
  if (!r1.ok) { compressJob = null; cleanup(); return job.cancelled ? { ok: false, cancelled: true } : r1; }
  const r2 = await runPass(2, out);
  compressJob = null;
  cleanup();
  if (job.cancelled) return { ok: false, cancelled: true };
  if (!r2.ok) { try { fs.unlinkSync(out); } catch { /* partial */ } return r2; }
  try { return { ok: true, path: out, bytes: fs.statSync(out).size }; }
  catch { return { ok: false, error: 'The compressed file is missing.' }; }
});

ipcMain.on('compress:cancel', (_e, id) => {
  if (compressJob && compressJob.id === id) {
    compressJob.cancelled = true;
    try { compressJob.proc.kill(); } catch { /* already gone */ }
  }
});

const familyOf = (ffCodec) => (/_nvenc$/.test(ffCodec) ? 'nvenc' : /_amf$/.test(ffCodec) ? 'amf' : /_qsv$/.test(ffCodec) ? 'qsv' : ffCodec === 'libx265' ? 'x265' : 'x264');
const pick = (v, allowed, def) => (allowed.includes(v) ? v : def);
const PRESETS = {
  nvenc: ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7'],
  amf: ['speed', 'balanced', 'quality'],
  qsv: ['veryfast', 'faster', 'fast', 'medium', 'slow', 'slower', 'veryslow'],
  x264: ['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium', 'slow'],
  x265: ['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium'],
};
const DEFAULT_PRESET = { nvenc: 'p5', amf: 'quality', qsv: 'medium', x264: 'veryfast', x265: 'superfast' };

/**
 * Video encoder arguments for one encode.
 * o: { ffCodec, fps, bitrate (kbps), tune: { preset, rc: 'vbr'|'cbr'|'cq', cq }, keyint (s), live (streaming) }
 */
function encoderArgs(o) {
  const fam = familyOf(o.ffCodec);
  const t = o.tune || {};
  const br = Math.max(500, Math.round(o.bitrate || 16000));
  const gop = String(Math.max(1, Math.round(o.fps * Math.min(10, Math.max(0.5, Number(o.keyint) || 2)))));
  const rc = o.live ? 'cbr' : pick(t.rc, ['vbr', 'cbr', 'cq'], 'vbr');
  const q = Math.min(51, Math.max(1, Math.round(Number(t.cq) || 22)));
  const preset = pick(t.preset, PRESETS[fam], DEFAULT_PRESET[fam]);
  const cbr = ['-b:v', `${br}k`, '-maxrate', `${br}k`, '-bufsize', `${br * 2}k`];
  const vbr = ['-b:v', `${br}k`, '-maxrate', `${Math.round(br * 1.5)}k`, '-bufsize', `${br * 2}k`];
  const a = [];

  if (fam === 'nvenc') {
    a.push('-preset', preset, '-tune', 'hq', '-spatial-aq', '1', '-g', gop);
    if (!o.live) a.push('-rc-lookahead', '16');
    if (o.ffCodec === 'h264_nvenc') a.push('-profile:v', 'high', '-bf', '2');
    else if (o.ffCodec === 'hevc_nvenc') a.push('-profile:v', 'main', '-bf', '2');
    if (rc === 'cbr') a.push('-rc', 'cbr', ...cbr);
    else if (rc === 'cq') a.push('-rc', 'vbr', '-cq', String(q), '-b:v', '0');
    else a.push('-rc', 'vbr', ...vbr);
    if (o.live) a.push('-forced-idr', '1');
  } else if (fam === 'amf') {
    // AMD AMF (Radeon VCN). AV1 needs an RX 7000-series (RDNA3) or newer GPU.
    const isAv1 = o.ffCodec === 'av1_amf';
    a.push('-usage', 'transcoding', '-quality', preset, '-g', gop);
    if (o.ffCodec === 'h264_amf') a.push('-profile:v', 'high');
    if (rc === 'cq') {
      // Constant QP. H.264/HEVC use 0–51; AV1 uses a 0–255 q-index, so scale the same "feel" across.
      const qp = String(isAv1 ? q * 5 : q);
      a.push('-rc', 'cqp', '-qp_i', qp, '-qp_p', qp);
      if (o.ffCodec === 'h264_amf') a.push('-qp_b', qp);
    } else if (rc === 'cbr') a.push('-rc', 'cbr', ...cbr);
    else a.push('-rc', 'vbr_peak', ...vbr);
    if (!isAv1 && rc !== 'cq') a.push('-vbaq', '1');
    if (o.live) a.push('-enforce_hrd', '1');
    if (o.live && o.ffCodec === 'h264_amf') a.push('-header_spacing', gop);
  } else if (fam === 'qsv') {
    // Intel Quick Sync. CBR is selected when maxrate == bitrate; ICQ (global_quality) for constant quality.
    a.push('-preset', preset, '-g', gop);
    if (o.ffCodec === 'h264_qsv') a.push('-profile:v', 'high');
    if (rc === 'cq') a.push('-global_quality', String(q));
    else a.push(...(rc === 'cbr' ? cbr : vbr));
  } else {
    // Software (CPU): x264 takes NV12 directly; x265 wants planar 4:2:0.
    const x265 = fam === 'x265';
    if (x265) a.push('-pix_fmt', 'yuv420p', '-x265-params', 'log-level=error');
    else a.push('-profile:v', 'high');
    a.push('-preset', preset, '-g', gop);
    if (o.live) a.push('-keyint_min', gop, '-sc_threshold', '0');
    if (rc === 'cq') a.push('-crf', String(q));
    else a.push(...(rc === 'cbr' ? cbr : vbr));
  }
  return a;
}

/* ------------------------------------------------------------------ */
/* Encoder benchmark                                                   */
/*                                                                     */
/* Renders a short, moving, noisy NV12 clip once (at the user's output */
/* size), then times real encodes of it through each candidate encoder */
/* — the same pixel format and arguments a recording uses — stepping   */
/* from the best-quality preset down until one keeps up in real time.  */
/* ------------------------------------------------------------------ */
ipcMain.handle('gpu:info', async () => {
  try {
    const info = await app.getGPUInfo('complete');
    const devs = (info.gpuDevice || []).filter((d) => d.deviceString && !/basic render/i.test(d.deviceString));
    const d = devs.find((x) => x.active) || devs[0];
    // Every GPU, not just the active one: laptops often pair Intel graphics with an NVIDIA / AMD card.
    const devices = devs.map((x) => ({ name: x.deviceString, vendorId: x.vendorId, driver: x.driverVersion || '' }));
    if (d) return { name: d.deviceString, vendorId: d.vendorId, driver: d.driverVersion || '', devices };
    const m = /ANGLE \([^,]+, ([^(,]+)/.exec((info.auxAttributes || {}).glRenderer || '');
    return { name: m ? m[1].trim() : 'Unknown GPU', vendorId: 0, driver: '' };
  } catch { return { name: 'Unknown GPU', vendorId: 0, driver: '' }; }
});

let bench = null; // { cancelled, proc, clip }

function benchSend(d) { if (win) win.webContents.send('bench:progress', d); }

function runTimed(ff, args, timeoutMs) {
  return new Promise((resolve) => {
    const t0 = process.hrtime.bigint();
    const p = spawn(ff, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    if (bench) bench.proc = p;
    let err = '';
    p.stderr.on('data', (x) => { err += x.toString(); if (err.length > 4000) err = err.slice(-2000); });
    const t = setTimeout(() => { try { p.kill(); } catch { /* ignore */ } }, timeoutMs);
    p.on('error', (e) => { clearTimeout(t); resolve({ ok: false, ms: 0, err: e.message }); });
    p.on('close', (code) => {
      clearTimeout(t);
      resolve({ ok: code === 0, ms: Number(process.hrtime.bigint() - t0) / 1e6, err: err.trim().split('\n').pop() || '' });
    });
  });
}

ipcMain.handle('bench:cancel', () => {
  if (bench) { bench.cancelled = true; try { if (bench.proc) bench.proc.kill(); } catch { /* ignore */ } }
  return true;
});

/**
 * o: { w, h, fps, bitrate, jobs: [{ id, ffCodec, presets: [best .. fastest], target }] }
 * target = minimum speed (x real time) a preset must reach to count as "keeps up".
 * Resolves { ok, results: { [id]: { preset, speed, ok, tried: [{ preset, speed, ok }] } } }.
 */
ipcMain.handle('bench:run', async (_e, o) => {
  const ff = ffmpegPath();
  if (!ff) return { ok: false, error: 'ffmpeg is not available.' };
  if (bench) return { ok: false, error: 'A benchmark is already running.' };
  const w = Math.round(o.w / 2) * 2, h = Math.round(o.h / 2) * 2, fps = Math.max(1, Math.round(o.fps));
  const CLIP = 30, LOOPS = 3; // 30 unique frames played 4x = 120 frames per trial
  const frames = CLIP * (LOOPS + 1);
  const clip = path.join(os.tmpdir(), `velocity-bench-${process.pid}-${Date.now()}.nv12`);
  bench = { cancelled: false, proc: null, clip };
  const results = {};
  try {
    benchSend({ phase: 'prepare' });
    // Motion (testsrc2 scrolls) plus temporal grain, so encoders do real work instead of coasting on a static frame.
    const gen = await runTimed(ff, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i',
      `testsrc2=s=${w}x${h}:r=${fps},noise=alls=10:allf=t+u,format=nv12`, '-frames:v', String(CLIP), '-f', 'rawvideo', clip], 60000);
    if (!gen.ok || bench.cancelled) return { ok: false, error: bench.cancelled ? 'cancelled' : `Could not prepare the test clip: ${gen.err}` };

    const total = o.jobs.reduce((n, j) => n + j.presets.length, 0);
    let done = 0;
    for (const job of o.jobs) {
      const r = { preset: null, speed: 0, ok: false, tried: [] };
      results[job.id] = r;
      for (const preset of job.presets) {
        if (bench.cancelled) return { ok: false, error: 'cancelled' };
        benchSend({ phase: 'encode', id: job.id, preset, done, total });
        const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
          '-stream_loop', String(LOOPS), '-f', 'rawvideo', '-pix_fmt', 'nv12', '-video_size', `${w}x${h}`, '-framerate', String(fps), '-i', clip,
          '-c:v', job.ffCodec, ...encoderArgs({ ffCodec: job.ffCodec, fps, bitrate: o.bitrate, keyint: 2, live: !!job.live, tune: { preset, rc: job.live ? 'cbr' : 'vbr' } }),
          '-f', 'null', '-'];
        // Give up on a trial once it is clearly far too slow (under ~0.3x real time).
        const t = await runTimed(ffFor(job.ffCodec), args, Math.max(4000, (frames / fps) * 3500));
        const speed = t.ok && t.ms > 0 ? (frames / fps) / (t.ms / 1000) : 0;
        const ok = t.ok && speed >= job.target;
        r.tried.push({ preset, speed, ok, err: t.ok ? undefined : t.err });
        done++;
        if (!t.ok && r.tried.length === 1 && !bench.cancelled) {
          // Encoder failed outright (not just slow): skip its remaining presets.
          done += job.presets.length - 1;
          break;
        }
        if (ok) { r.preset = preset; r.speed = speed; r.ok = true; done += job.presets.length - r.tried.length; break; }
      }
      if (!r.ok && r.tried.length) {
        const best = r.tried.reduce((a, b) => (b.speed > a.speed ? b : a));
        r.preset = best.preset; r.speed = best.speed;
      }
      benchSend({ phase: 'result', id: job.id, result: r, done, total });
    }
    return { ok: true, results };
  } finally {
    try { fs.unlinkSync(clip); } catch { /* ignore */ }
    bench = null;
  }
});

const toBuf = (d) => (Buffer.isBuffer(d) ? d : d instanceof ArrayBuffer ? Buffer.from(d) : Buffer.from(d.buffer, d.byteOffset, d.byteLength));

ipcMain.handle('enc:start', async (_e, o) => {
  const ff = ffmpegPath();
  if (!ff) return { ok: false, error: 'ffmpeg is not available.' };
  await fs.promises.mkdir(o.dir, { recursive: true });
  const safe = o.name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim() || 'recording';
  const finalPath = uniquePath(path.join(o.dir, `${safe}.${o.target}`));
  const base = finalPath.replace(/\.[^.]+$/, '');
  const vPath = `${base}.video.tmp.mkv`;
  const aPath = `${base}.audio.tmp.webm`;
  const args = [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
    '-f', 'rawvideo', '-pix_fmt', 'nv12', '-video_size', `${o.w}x${o.h}`, '-framerate', String(o.fps), '-i', 'pipe:0',
    '-c:v', o.ffCodec, ...encoderArgs(o),
    '-vf', BT709, ...BT709_FLAGS,
    '-f', 'matroska', vPath,
  ];
  const proc = spawn(ffFor(o.ffCodec), args, { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true });
  const id = ++encSeq;
  const s = {
    id, proc, vPath, aPath, finalPath, base,
    frameSize: (o.w * o.h * 3) / 2,
    nextIdx: 0, last: null, dropped: 0, closed: false, err: '', failed: false,
    audio: fs.createWriteStream(aPath),
    exited: null,
  };
  proc.stderr.on('data', (d) => { s.err += d.toString(); if (s.err.length > 4000) s.err = s.err.slice(-2000); });
  proc.stdin.on('error', () => { s.failed = true; });
  s.exited = new Promise((resolve) => {
    proc.on('error', (err) => { s.err += err.message; s.failed = true; resolve(-1); });
    proc.on('close', (code) => {
      s.failed = s.failed || code !== 0;
      if (!s.closed && win) win.webContents.send('enc:died', { id, error: s.err.trim().split('\n').pop() || `ffmpeg exited with ${code}` });
      resolve(code);
    });
  });
  // Detect immediate failures (e.g. no encoder session available) before declaring success.
  const alive = await Promise.race([new Promise((r) => setTimeout(() => r(true), 450)), s.exited.then(() => false)]);
  if (!alive) {
    try { s.audio.destroy(); fs.unlink(aPath, () => {}); fs.unlink(vPath, () => {}); } catch { /* ignore */ }
    return { ok: false, error: s.err.trim().split('\n').pop() || 'Encoder failed to start.' };
  }
  encs.set(id, s);
  return { ok: true, id, path: finalPath };
});

ipcMain.on('enc:frame', (_e, id, idx, data) => {
  const s = encs.get(id);
  if (!s || s.closed || s.failed) return;
  const buf = toBuf(data);
  if (buf.length !== s.frameSize) return;
  if (idx < s.nextIdx) { s.dropped++; return; }
  const stdin = s.proc.stdin;
  // Recording prefers buffering (~96 MB) over dropping; a stalled encoder still can't grow memory without bound.
  if (stdin.writableLength > Math.max(8, Math.floor(96e6 / s.frameSize)) * s.frameSize) { s.dropped++; return; }
  for (; s.nextIdx < idx; s.nextIdx++) stdin.write(s.last || buf); // fill gaps so timing stays constant-rate
  stdin.write(buf);
  s.last = buf;
  s.nextIdx = idx + 1;
});

ipcMain.on('enc:audio', (_e, id, data) => {
  const s = encs.get(id);
  if (s && !s.closed) s.audio.write(toBuf(data));
});

ipcMain.handle('enc:size', (_e, id) => {
  const s = encs.get(id);
  if (!s) return null;
  let bytes = 0;
  try { bytes = fs.statSync(s.vPath).size + s.audio.bytesWritten; } catch { /* file not flushed yet */ }
  return { bytes, dropped: s.dropped };
});

function runMux(ff, args) {
  return new Promise((resolve) => {
    const p = spawn(ff, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let err = '';
    p.stderr.on('data', (d) => { err += d.toString(); });
    p.on('error', (e) => resolve({ ok: false, error: e.message }));
    p.on('close', (code) => resolve(code === 0 ? { ok: true } : { ok: false, error: err.trim().split('\n').pop() || `ffmpeg exited with ${code}` }));
  });
}

ipcMain.handle('enc:stop', async (_e, id, o = {}) => {
  const s = encs.get(id);
  if (!s) return { ok: false, error: 'Unknown recording' };
  s.closed = true;
  try { s.proc.stdin.end(); } catch { /* already closed */ }
  const code = await Promise.race([s.exited, new Promise((r) => setTimeout(() => r('timeout'), 60000))]);
  if (code === 'timeout') { try { s.proc.kill(); } catch { /* ignore */ } }
  await new Promise((r) => s.audio.end(r));
  encs.delete(id);

  const rm = (p) => { try { fs.unlinkSync(p); } catch { /* ignore */ } };
  if (code !== 0 || !fs.existsSync(s.vPath) || fs.statSync(s.vPath).size === 0) {
    rm(s.aPath);
    const keep = fs.existsSync(s.vPath) && fs.statSync(s.vPath).size > 0;
    const salvage = keep ? uniquePath(`${s.base}.mkv`) : null;
    if (keep) { try { fs.renameSync(s.vPath, salvage); } catch { /* ignore */ } }
    return { ok: false, error: s.err.trim().split('\n').pop() || 'The hardware encoder stopped unexpectedly.', path: salvage };
  }

  const ff = ffmpegPath();
  const hasAudio = fs.existsSync(s.aPath) && fs.statSync(s.aPath).size > 0;
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y'];
  const off = (o.audioOffsetMs || 0) / 1000;
  if (hasAudio) {
    if (off < 0) args.push('-itsoffset', String(-off), '-i', s.vPath, '-i', s.aPath);
    else args.push('-i', s.vPath, '-itsoffset', String(off), '-i', s.aPath);
    args.push('-map', '0:v:0', '-map', '1:a:0');
  } else {
    args.push('-i', s.vPath, '-map', '0:v:0');
  }
  args.push('-c:v', 'copy');
  if (hasAudio) {
    if (o.target === 'mp4') args.push('-c:a', 'aac', '-b:a', `${o.audioBitrate || 192}k`);
    else args.push('-c:a', 'copy');
  }
  if (o.target === 'mp4') {
    args.push('-movflags', '+faststart');
    if (o.codec === 'hevc') args.push('-tag:v', 'hvc1');
  }
  args.push(s.finalPath);
  const r = await runMux(ff, args);
  if (r.ok && fs.existsSync(s.finalPath)) {
    rm(s.vPath); rm(s.aPath);
    return { ok: true, path: s.finalPath, bytes: fs.statSync(s.finalPath).size, dropped: s.dropped };
  }
  // Muxing failed: keep the (video-only) encode rather than lose the recording.
  rm(s.finalPath); rm(s.aPath);
  const salvage = uniquePath(`${s.base}.mkv`);
  try { fs.renameSync(s.vPath, salvage); } catch { /* ignore */ }
  return { ok: true, path: salvage, bytes: fs.existsSync(salvage) ? fs.statSync(salvage).size : 0, dropped: s.dropped, warning: `Could not mux audio (${r.error}). Saved the video track only.` };
});

/* ------------------------------------------------------------------ */
/* Live streaming (RTMP / RTMPS via ffmpeg)                            */
/*                                                                     */
/* Frames (NV12) arrive over IPC and are piped into ffmpeg's stdin;    */
/* mixed audio arrives as 48 kHz stereo float PCM and is fed to ffmpeg */
/* over a loopback TCP socket (Windows has no extra stdio pipes).      */
/* Video is timestamped on arrival, audio by its sample count.        */
/* ------------------------------------------------------------------ */
const streams = new Map();
let streamSeq = 0;

const scrub = (s, key) => {
  let t = String(s || '');
  if (key) t = t.split(key).join('••••');
  return t.replace(/(rtmps?:\/\/[^\s/]+\/[^\s/]+\/)\S+/gi, '$1••••').trim();
};

function streamStatus(s, phase, extra = {}) {
  s.phase = phase;
  if (win) win.webContents.send('stream:status', { id: s.id, phase, ...extra });
}

/**
 * Input queue size for a live (stdin / socket) input. ffmpeg 9 removed -thread_queue_size as an input option
 * (it now only applies to muxers), so it's passed only to the 6.1.1 compatibility build, where it still helps.
 */
const inputQueue = (ff, n) => (ff && ff === ffExe('legacy') ? ['-thread_queue_size', String(n)] : []);

function streamArgs(s, ff) {
  const o = s.o;
  const br = Math.max(500, Math.round(o.bitrate));
  // Keyframes every 2 s (Twitch/YouTube/Kick requirement) are set by encoderArgs({ keyint: 2 }).
  const a = [
    '-hide_banner', '-loglevel', 'warning', '-nostdin', '-y',
    '-use_wallclock_as_timestamps', '1', ...inputQueue(ff, 64),
    '-f', 'rawvideo', '-pix_fmt', 'nv12', '-video_size', `${o.w}x${o.h}`, '-framerate', String(o.fps), '-i', 'pipe:0',
    // Audio is timed by its sample count (the renderer's audio clock delivers exactly real-time PCM); video by
    // arrival time, since frames can be dropped. ffmpeg 9 mis-times wallclock-stamped raw audio (absolute
    // timestamps, most samples dropped), so audio must not use -use_wallclock_as_timestamps.
    ...inputQueue(ff, 512),
    '-f', 'f32le', '-ar', '48000', '-ac', '2', '-i', `tcp://127.0.0.1:${s.port}`,
    '-map', '0:v:0', '-map', '1:a:0',
  ];
  const filters = [BT709];
  if (o.outW !== o.w || o.outH !== o.h) filters.push(`scale=${o.outW}:${o.outH}:flags=bilinear`);
  if (filters.length) a.push('-vf', filters.join(','));
  a.push('-fps_mode', 'cfr', '-r', String(o.outFps));
  const ffCodec = streamCodec(o.encoder);
  a.push('-c:v', ffCodec, ...encoderArgs({ ffCodec, fps: o.outFps, bitrate: br, keyint: 2, live: true, tune: { preset: o.preset, rc: 'cbr' } }));
  if (ffCodec === 'libx264') a.push('-pix_fmt', 'yuv420p');
  a.push(...BT709_FLAGS);
  a.push('-af', 'aresample=async=1000', '-c:a', 'aac', '-b:a', `${Math.round(o.audioBitrate)}k`, '-ar', '48000', '-ac', '2');
  a.push('-f', 'flv', '-flvflags', 'no_duration_filesize', '-progress', 'pipe:1', '-stats_period', '1', s.url);
  return a;
}

const streamCodec = (encoder) => ({ nvenc: 'h264_nvenc', amf: 'h264_amf', qsv: 'h264_qsv' }[encoder] || 'libx264');

function spawnStream(s) {
  const ff = ffFor(streamCodec(s.o.encoder));
  s.prog = {};
  s.err = '';
  s.backlogDrops = 0;
  const proc = spawn(ff, streamArgs(s, ff), { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  s.proc = proc;
  streamStatus(s, s.attempts > 0 ? 'reconnecting' : 'connecting', { attempt: s.attempts });
  proc.stdin.on('error', () => { /* ffmpeg exited; close handler deals with it */ });
  proc.stderr.on('data', (d) => { s.err += d.toString(); if (s.err.length > 4000) s.err = s.err.slice(-2000); });
  let buf = '';
  proc.stdout.on('data', (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      const eq = line.indexOf('=');
      if (eq < 0) continue;
      s.prog[line.slice(0, eq)] = line.slice(eq + 1);
      if (line.startsWith('progress=')) {
        const p = s.prog;
        if (Number(p.frame) > 0) {
          if (s.phase !== 'live') { s.everLive = true; s.attempts = 0; }
          streamStatus(s, 'live', {
            kbps: parseFloat(p.bitrate) || 0,
            fps: parseFloat(p.fps) || 0,
            speed: p.speed || '',
            dropped: (Number(p.drop_frames) || 0) + s.backlogDrops + s.totalBacklogDrops,
          });
        }
      }
    }
  });
  const onEnd = (code) => {
    if (s.proc !== proc) return;
    s.proc = null;
    if (s.closed) return;
    const msg = scrub(s.err.trim().split('\n').filter(Boolean).slice(-2).join(' — ') || `ffmpeg exited with code ${code}`, s.key);
    s.totalBacklogDrops += s.backlogDrops;
    const giveUp = !s.o.reconnect || s.attempts >= 10 || (!s.everLive && s.attempts >= 1);
    if (giveUp) {
      streamStatus(s, 'error', { error: msg });
      teardownStream(s);
    } else {
      s.attempts += 1;
      streamStatus(s, 'reconnecting', { attempt: s.attempts, error: msg });
      s.timer = setTimeout(() => { if (!s.closed) spawnStream(s); }, 3000);
    }
  };
  proc.on('error', (err) => { s.err += err.message; onEnd(-1); });
  proc.on('close', onEnd);
}

function teardownStream(s) {
  s.closed = true;
  clearTimeout(s.timer);
  try { if (s.sock) s.sock.destroy(); } catch { /* ignore */ }
  try { s.server.close(); } catch { /* ignore */ }
  streams.delete(s.id);
}

ipcMain.handle('stream:start', async (_e, o) => {
  if (streams.size) return { ok: false, error: 'Already streaming.' };
  const ff = ffmpegPath();
  if (!ff) return { ok: false, error: 'ffmpeg is not available.' };
  const server = String(o.server || '').trim().replace(/\/+$/, '');
  if (!/^rtmps?:\/\/[^\s]+$/i.test(server)) return { ok: false, error: 'The server URL must start with rtmp:// or rtmps://' };
  if (!o.key || /\s/.test(o.key)) return { ok: false, error: 'Enter your stream key in Settings → Stream.' };
  const s = {
    id: ++streamSeq, o, key: o.key, url: `${server}/${o.key}`, phase: 'connecting',
    frameSize: (o.w * o.h * 3) / 2, attempts: 0, everLive: false, closed: false,
    proc: null, sock: null, timer: null, prog: {}, err: '', backlogDrops: 0, totalBacklogDrops: 0,
  };
  s.server = net.createServer((sock) => {
    if (s.sock) s.sock.destroy();
    s.sock = sock;
    sock.setNoDelay(true);
    sock.on('error', () => {});
    sock.on('close', () => { if (s.sock === sock) s.sock = null; });
  });
  await new Promise((resolve) => s.server.listen(0, '127.0.0.1', resolve));
  s.port = s.server.address().port;
  streams.set(s.id, s);
  spawnStream(s);
  return { ok: true, id: s.id };
});

ipcMain.on('stream:frame', (_e, id, data) => {
  const s = streams.get(id);
  if (!s || s.closed || !s.proc || !s.proc.stdin.writable) return;
  const buf = toBuf(data);
  if (buf.length !== s.frameSize) return;
  if (s.proc.stdin.writableLength > s.frameSize * 4) { s.backlogDrops++; return; } // encoder/network too slow: drop, never stall the app
  s.proc.stdin.write(buf);
});

ipcMain.on('stream:audio', (_e, id, data) => {
  const s = streams.get(id);
  if (!s || s.closed || !s.sock || !s.sock.writable || s.sock.writableLength > 1 << 20) return;
  s.sock.write(toBuf(data));
});

ipcMain.handle('stream:stop', async (_e, id) => {
  const s = streams.get(id);
  if (!s) return { ok: true };
  s.closed = true;
  clearTimeout(s.timer);
  const proc = s.proc;
  if (proc) {
    try { proc.stdin.end(); } catch { /* ignore */ }
    try { if (s.sock) s.sock.end(); } catch { /* ignore */ }
    await Promise.race([new Promise((r) => proc.once('close', r)), new Promise((r) => setTimeout(r, 3000))]);
    try { proc.kill(); } catch { /* already gone */ }
  }
  teardownStream(s);
  return { ok: true };
});

/* ---- stream keys: encrypted at rest with Windows DPAPI via Electron safeStorage ---- */
const secretsFile = () => path.join(app.getPath('userData'), 'secrets.json');
const readSecrets = () => { try { return JSON.parse(fs.readFileSync(secretsFile(), 'utf8')); } catch { return {}; } };
const validSecretName = (n) => /^streamkey:[a-z0-9_-]{1,32}$/.test(String(n));

ipcMain.handle('secret:available', () => safeStorage.isEncryptionAvailable());
ipcMain.handle('secret:set', (_e, name, value) => {
  if (!validSecretName(name) || !safeStorage.isEncryptionAvailable()) return false;
  const all = readSecrets();
  if (!value) delete all[name];
  else all[name] = safeStorage.encryptString(String(value)).toString('base64');
  fs.mkdirSync(path.dirname(secretsFile()), { recursive: true });
  fs.writeFileSync(secretsFile(), JSON.stringify(all));
  return true;
});
ipcMain.handle('secret:get', (_e, name) => {
  if (!validSecretName(name) || !safeStorage.isEncryptionAvailable()) return '';
  const v = readSecrets()[name];
  if (!v) return '';
  try { return safeStorage.decryptString(Buffer.from(v, 'base64')); } catch { return ''; }
});

/* ------------------------------------------------------------------ */
/* Hotkeys                                                             */
/* ------------------------------------------------------------------ */
ipcMain.handle('hotkeys:set', (_e, map) => {
  globalShortcut.unregisterAll();
  const failed = [];
  for (const [action, accel] of Object.entries(map || {})) {
    if (!accel) continue;
    try {
      const ok = globalShortcut.register(accel, () => {
        if (win) win.webContents.send('hotkey', action);
      });
      if (!ok) failed.push(action);
    } catch { failed.push(action); }
  }
  return failed;
});

/* ------------------------------------------------------------------ */
/* Window control                                                      */
/* ------------------------------------------------------------------ */
ipcMain.handle('win:protect', (_e, on) => { if (win) win.setContentProtection(!!on); });
ipcMain.handle('win:minimize', () => { if (win) win.minimize(); });
ipcMain.handle('win:restore', () => { if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } });
ipcMain.handle('win:fullscreen', (_e, on) => { if (win) win.setFullScreen(!!on); });
let busy = false;
let forceQuit = false;
ipcMain.on('app:busy', (_e, b) => { busy = !!b; });

// Taskbar indicator: red dot while recording, amber bars when paused, cyan dot when live,
// and an animated progress bar while a recording is being finalised.
ipcMain.on('app:activity', (_e, a = {}) => {
  if (!win || win.isDestroyed()) return;
  if (IS_WIN) { // taskbar overlay badges are a Windows feature
    const o = overlayFor(a.rec, !!a.live);
    if (o) win.setOverlayIcon(o.icon, o.description);
    else win.setOverlayIcon(null, '');
  }
  if (a.rec === 'processing') win.setProgressBar(2, { mode: 'indeterminate' });
  else win.setProgressBar(-1);
});
ipcMain.handle('app:quit', () => { forceQuit = true; app.quit(); });

/* ------------------------------------------------------------------ */
/* System stats                                                        */
/* ------------------------------------------------------------------ */
let lastCpu = null;
function cpuSnapshot() {
  let idle = 0; let total = 0;
  for (const c of os.cpus()) {
    for (const k of Object.keys(c.times)) total += c.times[k];
    idle += c.times.idle;
  }
  return { idle, total };
}
ipcMain.handle('stats', async (_e, dir) => {
  const snap = cpuSnapshot();
  let cpu = 0;
  if (lastCpu) {
    const dt = snap.total - lastCpu.total;
    const di = snap.idle - lastCpu.idle;
    cpu = dt > 0 ? Math.max(0, Math.min(100, (1 - di / dt) * 100)) : 0;
  }
  lastCpu = snap;
  let free = null;
  try {
    let d = dir || defaultRecDir();
    while (d && !fs.existsSync(d)) { const up = path.dirname(d); if (up === d) break; d = up; }
    const st = await fs.promises.statfs(d);
    free = st.bavail * st.bsize;
  } catch { /* ignore */ }
  return { cpu, free };
});

/* ------------------------------------------------------------------ */
/* Self test hooks (npm run selftest)                                  */
/* ------------------------------------------------------------------ */
if (SELFTEST) {
  ipcMain.handle('selftest:shot', async (_e, file) => {
    const img = await win.webContents.capturePage();
    fs.writeFileSync(file, img.toPNG());
    return true;
  });
  ipcMain.handle('selftest:done', (_e, result) => {
    fs.writeFileSync(path.join(__dirname, 'selftest-result.json'), JSON.stringify(result, null, 2));
    setTimeout(() => app.quit(), 200);
  });
}
