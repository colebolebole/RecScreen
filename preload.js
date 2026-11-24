'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const invoke = (ch, ...a) => ipcRenderer.invoke(ch, ...a);

contextBridge.exposeInMainWorld('api', {
  info: () => invoke('app:info'),
  listSources: (opts) => invoke('sources:list', opts),
  pickFolder: (cur) => invoke('dialog:folder', cur),
  pickImage: () => invoke('dialog:image'),
  readFile: (p) => invoke('file:read', p),
  showInFolder: (p) => invoke('shell:show', p),
  openDir: (p) => invoke('shell:openDir', p),
  openFile: (p) => invoke('shell:openFile', p),
  saveShot: (o) => invoke('shot:save', o),

  recOpen: (o) => invoke('rec:open', o),
  recWrite: (id, buf) => ipcRenderer.send('rec:write', id, buf),
  recClose: (id, o) => invoke('rec:close', id, o),
  onRecProgress: (cb) => ipcRenderer.on('rec:progress', (_e, d) => cb(d)),

  probeEncoders: () => invoke('enc:probe'),
  gpuInfo: () => invoke('gpu:info'),
  ffmpegStatus: () => invoke('ffmpeg:status'),
  ffmpegInstall: (which) => invoke('ffmpeg:install', which),
  ffmpegCancel: () => invoke('ffmpeg:cancel'),
  ffmpegRemove: (which) => invoke('ffmpeg:remove', which),
  onFfmpegProgress: (cb) => { const f = (_e, d) => cb(d); ipcRenderer.on('ffmpeg:progress', f); return () => ipcRenderer.removeListener('ffmpeg:progress', f); },
  compressStart: (o) => invoke('compress:start', o),
  compressCancel: (id) => ipcRenderer.send('compress:cancel', id),
  onCompressProgress: (cb) => ipcRenderer.on('compress:progress', (_e, d) => cb(d)),
  benchRun: (o) => invoke('bench:run', o),
  benchCancel: () => invoke('bench:cancel'),
  onBenchProgress: (cb) => { const f = (_e, d) => cb(d); ipcRenderer.on('bench:progress', f); return () => ipcRenderer.removeListener('bench:progress', f); },
  encStart: (o) => invoke('enc:start', o),
  encFrame: (id, idx, buf) => ipcRenderer.send('enc:frame', id, idx, buf),
  encAudio: (id, buf) => ipcRenderer.send('enc:audio', id, buf),
  encSize: (id) => invoke('enc:size', id),
  encStop: (id, o) => invoke('enc:stop', id, o),
  onEncDied: (cb) => ipcRenderer.on('enc:died', (_e, d) => cb(d)),

  streamStart: (o) => invoke('stream:start', o),
  streamFrame: (id, buf) => ipcRenderer.send('stream:frame', id, buf),
  streamAudio: (id, buf) => ipcRenderer.send('stream:audio', id, buf),
  streamStop: (id) => invoke('stream:stop', id),
  onStreamStatus: (cb) => ipcRenderer.on('stream:status', (_e, d) => cb(d)),
  secretAvailable: () => invoke('secret:available'),
  secretSet: (name, v) => invoke('secret:set', name, v),
  secretGet: (name) => invoke('secret:get', name),

  setHotkeys: (map) => invoke('hotkeys:set', map),
  onHotkey: (cb) => ipcRenderer.on('hotkey', (_e, a) => cb(a)),

  protect: (on) => invoke('win:protect', on),
  minimize: () => invoke('win:minimize'),
  restore: () => invoke('win:restore'),
  fullscreen: (on) => invoke('win:fullscreen', on),
  quit: () => invoke('app:quit'),
  setActivity: (a) => ipcRenderer.send('app:activity', a),
  setBusy: (b) => ipcRenderer.send('app:busy', !!b),
  onRequestClose: (cb) => ipcRenderer.on('request-close', () => cb()),
  stats: (dir) => invoke('stats', dir),

  selftestShot: (f) => invoke('selftest:shot', f),
  selftestDone: (r) => invoke('selftest:done', r),
});
