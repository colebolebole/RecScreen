// Post-recording "Compress" section on the transport: size-target presets for sharing,
// two-pass x264 in the main process, with the V loader as the progress animation.
import { $, fmtBytes } from './util.js';
import { on } from './store.js';
import { toast } from './widgets.js';
import { createVLoader } from './vloader.js';
import { openSettings } from './settings.js';

export function initCompress() {
  const sec = $('#compress-sec');
  if (!sec) return;
  const idle = sec.querySelector('.cmp-idle');
  const busy = sec.querySelector('.cmp-busy');
  const done = sec.querySelector('.cmp-done');
  const pctEl = sec.querySelector('.cmp-pct');
  const phaseEl = sec.querySelector('.cmp-phase');
  const loader = createVLoader({ className: 'cmp-vl' });
  sec.querySelector('.cmp-v').append(loader);

  let lastRec = null, lastOut = null, running = false, seq = 0;

  const show = (which) => { idle.hidden = which !== 'idle'; busy.hidden = which !== 'busy'; done.hidden = which !== 'done'; };
  const open = (v) => sec.classList.toggle('open', v);

  on('recording', (e) => {
    const d = e.detail;
    if (d.phase === 'idle' && d.result && d.result.ok && d.result.path) {
      lastRec = d.result;
      if (!running) { show('idle'); open(true); }
    } else if (d.phase !== 'idle' && !running) {
      open(false);
    }
  });

  sec.querySelector('.cmp-x').onclick = () => open(false);
  sec.querySelector('.cmp-x2').onclick = () => open(false);
  sec.querySelector('.cmp-show').onclick = () => { if (lastOut) window.api.showInFolder(lastOut); };
  sec.querySelector('.cmp-cancel').onclick = () => window.api.compressCancel(`cmp${seq}`);

  window.api.onCompressProgress((d) => {
    if (!running) return;
    loader.setProgress(d.pct);
    pctEl.textContent = `${Math.round(d.pct * 100)}%`;
    phaseEl.textContent = d.phase === 1 ? 'Analyzing' : 'Compressing';
  });

  for (const chip of sec.querySelectorAll('.cmp-chip')) {
    chip.onclick = async () => {
      if (running || !lastRec) return;
      const mb = Number(chip.dataset.mb);
      running = true;
      const id = `cmp${++seq}`;
      show('busy');
      loader.jumpTo(0);
      loader.setBusy(false);
      loader.start();
      pctEl.textContent = '0%';
      phaseEl.textContent = 'Analyzing';
      const r = await window.api.compressStart({ input: lastRec.path, targetMB: mb, id });
      running = false;
      loader.stop();
      if (r.ok && r.already) {
        toast(`Already under ${mb} MB (${fmtBytes(r.bytes)}) — no compression needed.`, { kind: 'success' });
        show('idle');
      } else if (r.ok) {
        lastOut = r.path;
        sec.querySelector('.cmp-done-bytes').textContent = fmtBytes(r.bytes);
        sec.querySelector('.cmp-done-sub').textContent = `under ${mb} MB · ready to share`;
        show('done');
        toast(`Compressed to ${fmtBytes(r.bytes)} for sharing.`, {
          kind: 'success', timeout: 9000,
          actions: [
            { label: 'Show in folder', onClick: () => window.api.showInFolder(r.path) },
            { label: 'Play', onClick: () => window.api.openFile(r.path) },
          ],
        });
      } else if (r.cancelled) {
        show('idle');
      } else {
        show('idle');
        toast(`Compression failed: ${r.error}`, {
          kind: 'error', timeout: 10000,
          actions: /ffmpeg is not installed/.test(r.error || '') ? [{ label: 'Open Settings', onClick: openSettings }] : [],
        });
      }
    };
  }
}