// Settings dialog, shortcuts reference and about box.
import { state, emit, save, DEFAULT_SETTINGS } from './store.js';
import { h, deepClone, formatName, eventToAccelerator, prettyAccel } from './util.js';
import { modal, field, select, checkbox, numberInput, toast, segmented, collapsible } from './widgets.js';
import * as recorder from './recorder.js';

import * as compositor from './compositor.js';
import { resetAll, sync } from './resources.js';
import { icon } from './icons.js';
import * as audio from './audio.js';
import * as stream from './stream.js';
import { openBenchmark, driverHint } from './benchmark.js';
import { installFromSettings } from './ffmpeg-setup.js';

let appInfo = null;
export const setAppInfo = (i) => { appInfo = i; };

export async function applyHotkeys() {
  const failed = await window.api.setHotkeys(state.settings.hotkeys);
  if (failed && failed.length) {
    toast(`Could not register hotkey for: ${failed.join(', ')} (already used by another app?)`, { kind: 'warn', timeout: 8000 });
  }
}

/** A titled group of fields inside a settings pane. */
const SECTION_ICONS = { Encoder: 'gauge', File: 'folder', Canvas: 'display', 'Mixer sources': 'mic', Encoding: 'sliders', 'Global hotkeys': 'keyboard', Behavior: 'gear', Reset: 'refresh', Destination: 'stream', Quality: 'gauge' };
function section(title, ...children) {
  return h('section', { class: 'set-section' },
    h('h3', { class: 'set-title' }, h('span', { class: 'set-ic', html: icon(SECTION_ICONS[title] || 'gear', 12) }), title),
    ...children);
}

/** Range slider with a filled track and a live value readout. Returns the wrapper (with .setValue()). */
function rangeInput({ min, max, step = 1, value, format = String, onChange }) {
  const input = h('input', { type: 'range', class: 'fader slider', min, max, step });
  const out = h('span', { class: 'slider-value' });
  const paint = () => {
    input.style.setProperty('--fill', `${((Number(input.value) - min) / (max - min)) * 100}%`);
    out.textContent = format(Number(input.value));
  };
  input.addEventListener('input', () => { paint(); if (onChange) onChange(Number(input.value)); });
  const wrap = h('div', { class: 'slider-row' }, input, out);
  wrap.setValue = (v) => { input.value = Math.min(max, Math.max(min, Number(v))); paint(); };
  wrap.setValue(value);
  return wrap;
}

let closeSettings = null;

export function openSettings() {
  const d = deepClone(state.settings);
  const locked = recorder.rec.phase !== 'idle' || stream.isActive();
  const encs = recorder.supportedEncoders();

  /* ---- Output: file + encoder ---- */
  const pathIn = h('input', { type: 'text', class: 'text-input', value: d.recPath, readonly: true });
  const browse = async () => { const p = await window.api.pickFolder(d.recPath); if (p) { d.recPath = p; pathIn.value = p; } };
  pathIn.addEventListener('click', browse);
  const preview = h('span', { class: 'field-hint' });
  const fname = h('input', { type: 'text', class: 'text-input', value: d.filename });
  const updPrev = () => { preview.textContent = `Example: ${formatName(fname.value || '%CCYY-%MM-%DD %hh-%mm-%ss')}.${d.container}`; };
  fname.addEventListener('input', () => { d.filename = fname.value; updPrev(); });
  const contSel = select([{ value: 'mp4', label: 'MP4 (.mp4), plays everywhere' }, { value: 'mkv', label: 'MKV (.mkv), crash-safe' }, { value: 'webm', label: 'WebM (.webm)' }], d.container, (v) => { d.container = v; updPrev(); syncEncoder(); });

  // Encoder type -> encoder -> preset / rate control. Tuning is kept per family in d.tuning.
  const byKind = (k) => encs.filter((e) => recorder.kindOf(e) === k);
  const KIND_ORDER = ['hardware', 'software', 'builtin'];
  const curEnc = () => (d.encoder === 'auto' ? null : encs.find((e) => e.key === d.encoder));
  let encType = curEnc() ? recorder.kindOf(curEnc()) : 'auto';
  const typeSeg = segmented([
    { value: 'auto', label: 'Automatic' },
    { value: 'hardware', label: 'Hardware · GPU', disabled: !byKind('hardware').length, title: byKind('hardware').length ? '' : 'No GPU encoder is available on this PC' },
    { value: 'software', label: 'Software · CPU', disabled: !byKind('software').length },
    { value: 'builtin', label: 'Built-in', title: 'Chromium’s own encoders (fallback, no ffmpeg needed)' },
  ], encType, (v) => {
    encType = v;
    if (v === 'auto') d.encoder = 'auto';
    else if (!curEnc() || recorder.kindOf(curEnc()) !== v) d.encoder = (byKind(v)[0] || {}).key || 'auto';
    fillEncSel();
    syncEncoder();
  });
  const encSel = h('select', { class: 'select' });
  encSel.addEventListener('change', () => { d.encoder = encSel.value; syncEncoder(); });
  const fillEncSel = () => {
    encSel.replaceChildren(...byKind(encType).map((e) => { const o = h('option', { value: e.key }, e.label); o.selected = e.key === d.encoder; return o; }));
  };
  fillEncSel();
  const autoInfo = h('div', { class: 'info-line' });

  const presetSel = h('select', { class: 'select' });
  presetSel.addEventListener('change', () => { const e = active(); if (e) d.tuning[e.family].preset = presetSel.value; });
  const rcSeg = segmented([
    { value: 'vbr', label: 'VBR' }, { value: 'cbr', label: 'CBR' }, { value: 'cq', label: 'Constant quality' },
  ], 'vbr', (v) => { const e = active(); if (e) d.tuning[e.family].rc = v; syncEncoder(); });
  const rcHint = h('span', { class: 'field-hint' });

  const brSlider = rangeInput({ min: 2000, max: 80000, step: 500, value: d.videoBitrate, format: (v) => `${(v / 1000).toFixed(1)} Mbps`, onChange: (v) => { d.videoBitrate = v; } });
  const cqSlider = rangeInput({ min: 10, max: 40, step: 1, value: 22, reverse: true,
    format: (v) => `${v} · ${v <= 16 ? 'near-lossless' : v <= 20 ? 'very high' : v <= 24 ? 'high' : v <= 30 ? 'medium' : 'small files'}`,
    onChange: (v) => { const e = active(); if (e) d.tuning[e.family].cq = v; } });
  const keySel = select([1, 2, 3, 4, 5].map((v) => ({ value: v, label: `${v} s${v === 2 ? ' (default)' : ''}` })), d.keyint || 2, (v) => { d.keyint = Number(v); });

  const encPick = collapsible(field('Encoder', encSel), encType !== 'auto');
  const tuneBox = collapsible(h('div', {},
    h('div', { class: 'grid2' }, field('Preset', presetSel), field('Keyframe interval', keySel)),
    field('Rate control', rcSeg, rcHint)), false);
  const brBox = collapsible(field('Bitrate', brSlider), true);
  const cqBox = collapsible(field('Quality level (lower = better quality, bigger files)', cqSlider), false);

  /** Encoder that would actually record with the current draft. */
  const active = () => {
    const e = recorder.chooseEncoder(d.encoder, d.container);
    return e && e.backend === 'ffmpeg' ? e : null;
  };
  const RC_HINT = {
    vbr: 'Variable bitrate around the target. Best quality per MB for recordings.',
    cbr: 'Constant bitrate. Predictable file size, mostly useful for streaming.',
    cq: 'Constant quality. The bitrate floats to keep quality steady, so file size depends on the content.',
  };
  function syncEncoder() {
    const chosen = recorder.chooseEncoder(d.encoder, d.container);
    const e = active();
    encPick.setOpen(encType !== 'auto');
    autoInfo.replaceChildren(
      h('span', { class: 'info-dot' }),
      chosen ? h('span', {}, encType === 'auto' ? 'Records with ' : 'Using ', h('b', {}, chosen.label), recorder.kindOf(chosen) === 'hardware' ? '. Encoded on your GPU, so it barely affects games.' : recorder.kindOf(chosen) === 'software' ? '. Encoded on your CPU.' : ', Chromium’s built-in encoder.')
        : h('span', {}, 'No encoder is available for this container.'));
    tuneBox.setOpen(!!e);
    if (e) {
      const t = d.tuning[e.family];
      presetSel.replaceChildren(...recorder.FAMILIES[e.family].presets.map(([v, l]) => { const o = h('option', { value: v }, l); o.selected = v === t.preset; return o; }));
      rcSeg.value = t.rc;
      rcHint.textContent = RC_HINT[t.rc];
      cqSlider.setValue(t.cq);
    }
    const cq = !!e && d.tuning[e.family].rc === 'cq';
    brBox.setOpen(!cq);
    cqBox.setOpen(cq);
  }
  syncEncoder();

  const b = d.benchmark;
  const benchInfo = !b ? 'Not run yet on this PC.'
    : b.skipped || b.kept ? `Skipped${b.gpu ? ` · ${b.gpu}` : ''}.`
      : `Last run ${new Date(b.at).toLocaleDateString()} on ${b.gpu} at ${b.w}×${b.h} ${b.fps} fps.`;
  const benchCard = h('div', { class: 'bench-card' },
    h('span', { class: 'bench-card-ic', html: icon('gauge', 18) }),
    h('div', { class: 'bench-card-text' }, h('div', { class: 'bench-card-title' }, 'Encoder benchmark'), h('div', { class: 'field-hint' }, `Tests every encoder on this PC and picks the best settings. ${benchInfo}`)),
    h('button', { class: 'btn', type: 'button', disabled: locked, title: locked ? 'Stop recording and streaming first' : '', onclick: () => {
      // The benchmark writes settings directly, so close this dialog (discarding the draft) and reopen it after.
      if (closeSettings) closeSettings(null);
      openBenchmark({ reason: 'manual' }).then(() => openSettings());
    } }, b && !b.skipped && !b.kept ? 'Run again' : 'Run benchmark'));

  // ffmpeg not downloaded yet (skipped on first launch, or the download failed): offer it here.
  const ffHint = h('div', { class: 'field-hint' }, 'GPU (NVENC / AMF / Quick Sync) and x264 / x265 encoding need it. Until then, recordings use the built-in encoder.');
  const ffBtn = h('button', { class: 'btn primary', type: 'button', onclick: () => {
    if (closeSettings) closeSettings(null);
    installFromSettings()
      .then((ok) => (ok && !state.settings.benchmark ? openBenchmark({ reason: 'first-run' }) : null))
      .then(() => openSettings());
  } }, 'Download ffmpeg');
  const ffCard = h('div', { class: 'ff-card', hidden: true },
    h('span', { class: 'bench-card-ic', html: icon('folder', 18) }),
    h('div', { class: 'bench-card-text' }, h('div', { class: 'bench-card-title' }, 'ffmpeg isn’t installed'), ffHint),
    ffBtn);
  window.api.ffmpegStatus().then((st) => {
    ffCard.hidden = st.main;
    if (!st.managed) { // Linux: ffmpeg comes from the system package manager
      ffHint.textContent = 'GPU (NVENC) and x264 / x265 encoding need ffmpeg. Install it with your package manager (for example: sudo apt install ffmpeg), then restart the app. Until then, recordings use the built-in encoder.';
      ffBtn.hidden = true;
    }
  }).catch(() => {});
  const gpuNote = h('p', { class: 'note warn', hidden: true });
  window.api.gpuInfo().then((g) => { const t = driverHint(g); if (t) { gpuNote.textContent = t; gpuNote.hidden = false; } }).catch(() => {});
  const out = h('div', { class: 'pane' },
    section('Encoder',
      ffCard,
      field('Encoder type', typeSeg),
      autoInfo,
      gpuNote,
      encPick, tuneBox, brBox, cqBox,
      locked ? h('p', { class: 'note warn' }, 'Changes apply to the next recording.') : null,
      benchCard),
    section('File',
      field('Recording folder', h('div', { class: 'row tight' }, pathIn, h('button', { class: 'btn', type: 'button', onclick: browse }, 'Browse…'), h('button', { class: 'btn', type: 'button', onclick: () => window.api.openDir(d.recPath) }, 'Open'))),
      h('div', { class: 'grid2' }, field('Container', contSel), h('div', {}, field('Filename format', fname), preview)),
      h('p', { class: 'note' }, 'Tokens: %CCYY year · %MM month · %DD day · %hh hour · %mm minute · %ss second. ',
        'MP4 with a VP9/VP8 encoder is re-encoded to H.264 after recording; everything else is muxed in a moment when you stop.')),
  );
  updPrev();

  /* ---- Video ---- */
  const resSel = select([
    { value: 720, label: '1280 × 720 (720p)' }, { value: 900, label: '1600 × 900' }, { value: 1080, label: '1920 × 1080 (1080p)' },
    { value: 1440, label: '2560 × 1440 (1440p)' }, { value: 2160, label: '3840 × 2160 (4K)' },
  ], d.outputHeight, (v) => { d.outputHeight = Number(v); });
  const fpsSel = select([24, 30, 48, 60].map((f) => ({ value: f, label: `${f} fps` })), d.fps, (v) => { d.fps = Number(v); });
  if (locked) { resSel.disabled = true; fpsSel.disabled = true; }
  const video = h('div', { class: 'pane' },
    section('Canvas',
      h('div', { class: 'grid2' }, field('Output resolution', resSel), field('Frame rate', fpsSel)),
      locked ? h('p', { class: 'note warn' }, 'Stop recording and streaming to change the resolution or frame rate.') : null,
      h('p', { class: 'note' }, 'Scenes are laid out on a 16:9 canvas and scaled to the output resolution. Higher resolution and frame rate use more CPU/GPU. If the status bar shows fewer fps than selected, lower one of them or the bitrate.')),
  );

  /* ---- Audio ---- */
  const abSel = select([96, 128, 160, 192, 256, 320].map((v) => ({ value: v, label: `${v} kbps` })), d.audioBitrate, (v) => { d.audioBitrate = Number(v); });
  // One source picker per mixer channel: System audio (loopback) or any capture device / virtual cable.
  const chDraft = {};
  const chRows = h('div', { class: 'ch-rows' });
  const chSelects = state.audio.map((ch) => {
    const sel = h('select', { class: 'select' }, h('option', { value: audio.sourceValue(ch) }, 'Loading devices…'));
    chRows.append(h('div', { class: 'ch-row' }, h('div', { class: 'ch-row-name' }, ch.name), sel));
    sel.addEventListener('change', () => { chDraft[ch.id] = sel.value; });
    return { ch, sel };
  });
  audio.sourceOptions().then((opts) => {
    for (const { ch, sel } of chSelects) {
      const cur = audio.sourceValue(ch);
      const list = opts.some((o) => o.value === cur) ? opts : [...opts, { value: cur, label: `${cur} (unavailable)` }];
      sel.replaceChildren(...list.map((o) => { const el = h('option', { value: o.value }, o.label); if (o.value === cur) el.selected = true; return el; }));
    }
  }).catch(() => {});
  const audioPane = h('div', { class: 'pane' },
    section('Mixer sources',
      chRows,
      h('p', { class: 'note' }, 'Pick a microphone or any other capture device per channel. “System audio” records everything you hear through the Windows default output device. To capture a different output or a single app, route it through a virtual audio cable (e.g. VB-Cable or Voicemeeter) and choose that cable here as a device. Add more channels with + in the Audio Mixer.')),
    section('Encoding', field('Recording audio bitrate', abSel)),
  );

  /* ---- Hotkeys ---- */
  const hkRows = [['record', 'Start / Stop Recording'], ['pause', 'Pause / Resume Recording'], ['stream', 'Start / Stop Streaming'], ['screenshot', 'Take Screenshot']].map(([key, label]) => {
    const btn = h('button', { class: 'hotkey-btn', type: 'button' }, prettyAccel(d.hotkeys[key]) || 'Not set');
    const clear = h('button', { class: 'btn small', type: 'button', onclick: () => { d.hotkeys[key] = ''; btn.textContent = 'Not set'; } }, 'Clear');
    btn.addEventListener('click', () => {
      btn.textContent = 'Press a key combination…';
      btn.classList.add('listening');
      const handler = (e) => {
        e.preventDefault(); e.stopPropagation();
        if (e.key === 'Escape') { finish(); return; }
        const acc = eventToAccelerator(e);
        if (!acc) return;
        d.hotkeys[key] = acc;
        finish();
      };
      const finish = () => {
        document.removeEventListener('keydown', handler, true);
        btn.classList.remove('listening');
        btn.textContent = prettyAccel(d.hotkeys[key]) || 'Not set';
      };
      document.addEventListener('keydown', handler, true);
    });
    return h('div', { class: 'hk-row' }, h('span', {}, label), btn, clear);
  });
  const hotkeys = h('div', { class: 'pane' },
    section('Global hotkeys', ...hkRows,
      h('p', { class: 'note' }, 'Hotkeys work globally, even while Velocity Studio is minimized or another app has focus.')),
  );

  /* ---- General ---- */
  const general = h('div', { class: 'pane' },
    section('Behavior',
      checkbox('Hide Velocity Studio from screen captures', d.hideFromCapture, (v) => { d.hideFromCapture = v; }),
      h('p', { class: 'note' }, 'Excludes this window from display/window capture so it never shows up in your recordings (no infinite-mirror effect).'),
      checkbox('Minimize Velocity Studio when recording starts', d.minimizeOnRecord, (v) => { d.minimizeOnRecord = v; }),
      h('p', { class: 'note' }, 'Use the Start/Stop hotkey to control recording while minimized.')),
    section('Reset',
      h('div', { class: 'row tight' }, h('button', {
        class: 'btn',
        type: 'button',
        onclick: () => { Object.assign(d, deepClone(DEFAULT_SETTINGS), { recPath: d.recPath }); toast('Settings reset. Press Apply to keep them.', { kind: 'warn' }); },
      }, 'Reset to defaults'))),
  );

  /* ---- Stream ---- */
  const sc = d.stream;
  const streaming = stream.isActive();
  const keyDraft = {}; // service id -> key typed in this dialog
  let remember = true;
  let secretOk = true;
  const hint = h('p', { class: 'note' });
  const serverIn = h('input', { type: 'text', class: 'text-input', placeholder: 'rtmp://… or rtmps://…', spellcheck: false });
  const keyIn = h('input', { type: 'password', class: 'text-input', placeholder: 'Paste your stream key', autocomplete: 'off', spellcheck: false });
  const showBtn = h('button', { class: 'btn', type: 'button' }, 'Show');
  showBtn.addEventListener('click', () => { keyIn.type = keyIn.type === 'password' ? 'text' : 'password'; showBtn.textContent = keyIn.type === 'password' ? 'Show' : 'Hide'; });
  serverIn.addEventListener('input', () => { sc.servers[sc.service] = serverIn.value.trim(); });
  keyIn.addEventListener('input', () => { keyDraft[sc.service] = keyIn.value.trim(); });
  const refreshService = async () => {
    const svc = stream.serviceById(sc.service);
    serverIn.value = sc.servers[svc.id] != null ? sc.servers[svc.id] : svc.server;
    hint.textContent = svc.hint;
    if (keyDraft[svc.id] !== undefined) { keyIn.value = keyDraft[svc.id]; return; }
    keyIn.value = '';
    keyIn.placeholder = 'Loading…';
    const k = await stream.getKey(svc.id);
    if (sc.service === svc.id && keyDraft[svc.id] === undefined) { keyIn.value = k; keyIn.placeholder = 'Paste your stream key'; }
  };
  const svcSel = select(stream.SERVICES.map((s) => ({ value: s.id, label: s.name })), sc.service, (v) => { sc.service = v; refreshService(); });
  const secretNote = h('p', { class: 'note' }, 'Your stream key is stored encrypted with Windows (DPAPI) on this PC and never written to the settings file. Anyone with your key can stream to your channel, so keep it private and reset it if it leaks.');
  const rememberCb = checkbox('Remember stream keys on this PC', true, (v) => { remember = v; });
  window.api.secretAvailable().then((ok) => {
    secretOk = ok;
    if (!ok) { rememberCb.input.checked = false; rememberCb.input.disabled = true; remember = false; secretNote.textContent = 'Encrypted storage is not available on this system, so your key is kept in memory only and must be re-entered after restarting Velocity Studio.'; }
  });
  const sBitrate = numberInput(sc.bitrate, { min: 500, max: 60000, step: 250, onChange: (v) => { sc.bitrate = v || 6000; } });
  const sAudio = select([96, 128, 160, 192, 256].map((v) => ({ value: v, label: `${v} kbps` })), sc.audioBitrate, (v) => { sc.audioBitrate = Number(v); });
  const sHeight = select([{ value: 0, label: 'Same as canvas' }, { value: 1080, label: '1920 × 1080' }, { value: 900, label: '1600 × 900' }, { value: 720, label: '1280 × 720' }, { value: 540, label: '960 × 540' }], sc.height, (v) => { sc.height = Number(v); });
  const sFps = select([{ value: 0, label: 'Same as canvas' }, { value: 60, label: '60 fps' }, { value: 48, label: '48 fps' }, { value: 30, label: '30 fps' }, { value: 24, label: '24 fps' }], sc.fps, (v) => { sc.fps = Number(v); });
  const hwStream = [['nvenc', 'NVIDIA NVENC H.264', recorder.hasNvencH264()], ['amf', 'AMD AMF H.264', recorder.hasAmfH264()], ['qsv', 'Intel Quick Sync H.264', recorder.hasQsvH264()]].filter((x) => x[2]);
  const sEnc = select([
    { value: 'auto', label: hwStream.length ? `Automatic (${hwStream[0][1]})` : 'Automatic (x264, CPU)' },
    ...hwStream.map(([v, l]) => ({ value: v, label: `${l} (GPU)` })),
    { value: 'x264', label: 'x264 (CPU)' },
  ], sc.encoder, (v) => { sc.encoder = v; syncStreamPreset(); });
  const sPreset = select(recorder.FAMILIES.x264.presets.slice(0, 5).map(([v, l]) => ({ value: v, label: l })), sc.preset || 'veryfast', (v) => { sc.preset = v; });
  const sPresetBox = collapsible(field('x264 preset (faster = less CPU, slower = better quality)', sPreset), false);
  const syncStreamPreset = () => sPresetBox.setOpen(sc.encoder === 'x264' || (sc.encoder === 'auto' && !hwStream.length));
  syncStreamPreset();
  if (streaming) [sBitrate, sAudio, sHeight, sFps, sEnc, sPreset].forEach((el) => { el.disabled = true; });
  const streamPane = h('div', { class: 'pane' },
    section('Destination',
      field('Service', svcSel),
      hint,
      field('Server', serverIn),
      field('Stream key', h('div', { class: 'row tight' }, keyIn, showBtn)),
      rememberCb, secretNote),
    section('Quality',
      h('div', { class: 'grid2' }, field('Video bitrate (kbps, CBR)', sBitrate), field('Audio bitrate', sAudio)),
      h('div', { class: 'grid2' }, field('Stream resolution', sHeight), field('Stream frame rate', sFps)),
      h('div', { class: 'grid2' }, field('Encoder', sEnc), h('div', {}, h('div', { class: 'field-label' }, 'Connection'), checkbox('Reconnect automatically', sc.reconnect, (v) => { sc.reconnect = v; }))),
      sPresetBox,
      streaming ? h('p', { class: 'note warn' }, 'Stop streaming to change bitrate, resolution or encoder.') : null,
      h('p', { class: 'note' }, 'Keyframes are sent every 2 seconds, as Twitch, YouTube and Kick require. Streaming and recording can run at the same time; with a GPU encoder both share one GPU conversion.')),
  );
  refreshService();

  const tabs = [['Output', out], ['Video', video], ['Audio', audioPane], ['Stream', streamPane], ['Hotkeys', hotkeys], ['General', general]];
  const TAB_ICONS = { Output: 'gauge', Video: 'display', Audio: 'sliders', Stream: 'stream', Hotkeys: 'keyboard', General: 'gear' };
  const nav = h('div', { class: 'tabs-nav' });
  const ind = h('span', { class: 'tab-ind', 'aria-hidden': 'true' });
  nav.append(ind);
  const content = h('div', { class: 'tabs-content' });
  const buttons = [];
  let curTab = 0;
  const placeInd = () => {
    const b = buttons[curTab];
    if (!b || !b.offsetHeight) return;
    ind.style.height = `${b.offsetHeight}px`;
    ind.style.transform = `translateY(${b.offsetTop}px)`;
  };
  tabs.forEach(([name, pane], i) => {
    const b = h('button', { class: `tab-btn ${i === 0 ? 'active' : ''}`, type: 'button', onclick: () => {
      if (b.classList.contains('active')) return;
      const dir = i > curTab ? 1 : -1;
      curTab = i;
      buttons.forEach((x) => x.classList.remove('active')); b.classList.add('active');
      placeInd();
      tabs.forEach(([, p]) => { p.style.display = 'none'; p.classList.remove('pane-in'); });
      pane.style.display = '';
      pane.style.setProperty('--pane-dir', `${dir * 16}px`);
      void pane.offsetWidth; // restart the entrance animation
      pane.classList.add('pane-in');
      content.scrollTop = 0;
    } }, h('span', { class: 'tab-ic', html: icon(TAB_ICONS[name], 15) }), name);
    buttons.push(b); nav.append(b);
    pane.style.display = i === 0 ? '' : 'none';
    content.append(pane);
  });
  new ResizeObserver(placeInd).observe(nav);

  modal({
    title: 'Settings',
    width: 820,
    className: 'settings-modal',
    body: h('div', { class: 'settings-layout' }, nav, content),
    onOpen: ({ close }) => { closeSettings = close; requestAnimationFrame(placeInd); },
    onClose: () => { closeSettings = null; },
    buttons: [
      { label: 'Cancel', value: null },
      {
        label: 'Apply',
        primary: true,
        value: 'ok',
        onClick: async () => {
          applySettings(d);
          // audio source changes
          let audioChanged = false;
          for (const [id, value] of Object.entries(chDraft)) {
            const ch = state.audio.find((c) => c.id === id);
            if (ch && value !== audio.sourceValue(ch)) { audio.setSource(ch, value); audio.startChannel(ch); audioChanged = true; }
          }
          if (audioChanged) { emit('audio'); save(); }
          // stream keys
          for (const [id, key] of Object.entries(keyDraft)) {
            if (remember && secretOk) { await window.api.secretSet(stream.keyName(id), key); delete stream.memoryKeys[id]; }
            else { stream.memoryKeys[id] = key; if (secretOk) await window.api.secretSet(stream.keyName(id), ''); }
            if (!key) delete stream.memoryKeys[id];
          }
        },
      },
    ],
  });
}

function applySettings(d) {
  const old = state.settings;
  const videoChanged = old.outputHeight !== d.outputHeight || old.fps !== d.fps;
  state.settings = d;
  if (videoChanged) {
    compositor.applySize();
    compositor.setRate(d.fps);
    if (old.fps !== d.fps) { resetAll(); sync(); }
  }
  window.api.protect(d.hideFromCapture);
  applyHotkeys();
  save();
  emit('settings');
  emit('items');
}

export function openShortcuts() {
  const hk = state.settings.hotkeys;
  const rows = [
    ['Start / Stop recording', prettyAccel(hk.record)], ['Pause / Resume', prettyAccel(hk.pause)], ['Start / Stop streaming', prettyAccel(hk.stream)], ['Take screenshot', prettyAccel(hk.screenshot)],
    ['Move selected source', 'Arrow keys (Shift = 10 px)'], ['Remove selected source', 'Delete'],
    ['Free-aspect resize', 'Shift + drag a corner'], ['Crop source', 'Alt + drag a handle'], ['Disable snapping', 'Hold Ctrl while dragging'],
    ['Reset volume', 'Double-click a fader'], ['Source properties', 'Double-click a source'],
  ];
  modal({
    title: 'Keyboard Shortcuts',
    width: 480,
    body: h('div', { class: 'shortcuts' }, rows.map(([a, b]) => h('div', { class: 'sc-row' }, h('span', {}, a), h('kbd', {}, b || '—')))),
    buttons: [{ label: 'Close', primary: true, value: 'ok' }],
  });
}

export function openAbout() {
  modal({
    title: 'About Velocity Studio',
    width: 420,
    body: h('div', { class: 'about' },
      h('div', { class: 'about-logo' }, h('img', { src: 'icon.png', alt: '' })),
      h('h2', {}, 'Velocity Studio'),
      h('p', {}, `Version ${appInfo ? appInfo.version : '1.0.0'}`),
      h('p', { class: 'note' }, 'An OBS-style screen recorder and live streamer: scenes, multiple sources, audio mixer, NVENC / AMF hardware encoding, RTMP streaming, global hotkeys.')),
    buttons: [{ label: 'Close', primary: true, value: 'ok' }],
  });
}
