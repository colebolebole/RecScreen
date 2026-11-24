// Interactive preview: click to select, drag to move, handles to resize (Alt = crop, Shift = free aspect).
import { emit, save, activeScene, selectedItem, BASE_W, BASE_H } from './store.js';
import { $, clamp } from './util.js';
import { getRes } from './resources.js';
import { selectItem, editSource, nudge, removeItem } from './actions.js';
import { reduced, SPRING } from './motion.js';

const stage = $('#stage');
const area = $('#preview-area');
const sel = $('#sel');
const guideV = $('#guide-v');
const guideH = $('#guide-h');
const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
const CURSORS = { nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize', n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize' };

let k = 1; // css px per base px
let drag = null;

export function init() {
  for (const hd of HANDLES) {
    const el = document.createElement('div');
    el.className = `handle ${hd}`;
    el.dataset.h = hd;
    el.style.cursor = CURSORS[hd];
    sel.append(el);
  }
  new ResizeObserver(layout).observe(area);
  stage.addEventListener('pointerdown', onDown);
  stage.addEventListener('pointermove', onMove);
  stage.addEventListener('pointerup', onUp);
  stage.addEventListener('pointercancel', onUp);
  stage.addEventListener('dblclick', (e) => {
    const it = hit(e);
    if (it) editSource(it);
  });
  stage.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const it = hit(e);
    if (it) selectItem(it.id);
    emit('itemmenu', { item: it || selectedItem(), x: e.clientX, y: e.clientY });
  });
  document.addEventListener('keydown', onKey);
  layout();
}

export function layout() {
  const r = area.getBoundingClientRect();
  const pad = 16;
  const aw = Math.max(80, r.width - pad * 2);
  const ah = Math.max(60, r.height - pad * 2);
  let w = aw; let h = (aw * BASE_H) / BASE_W;
  if (h > ah) { h = ah; w = (ah * BASE_W) / BASE_H; }
  stage.style.width = `${Math.floor(w)}px`;
  stage.style.height = `${Math.floor(h)}px`;
  k = Math.floor(w) / BASE_W;
  updateOverlay();
}

let lastSelId = null;
export function updateOverlay() {
  const it = selectedItem();
  if (!it || !it.visible) { sel.style.display = 'none'; lastSelId = null; return; }
  sel.style.display = 'block';
  sel.style.left = `${it.x * k}px`;
  sel.style.top = `${it.y * k}px`;
  sel.style.width = `${it.w * k}px`;
  sel.style.height = `${it.h * k}px`;
  sel.classList.toggle('locked', it.locked);
  if (it.id !== lastSelId) {
    lastSelId = it.id;
    if (!reduced && !it.locked) sel.querySelectorAll('.handle').forEach((hd, i) => {
      hd.animate([{ transform: 'translate(-50%, -50%) scale(0)' }, { transform: 'translate(-50%, -50%) scale(1)' }],
        { duration: 280, delay: i * 16, easing: SPRING, fill: 'backwards' });
    });
  }
}

function toBase(e) {
  const r = stage.getBoundingClientRect();
  return { x: (e.clientX - r.left) / k, y: (e.clientY - r.top) / k };
}

function hit(e) {
  const sc = activeScene();
  if (!sc) return null;
  const p = toBase(e);
  for (let i = sc.items.length - 1; i >= 0; i--) {
    const it = sc.items[i];
    if (!it.visible) continue;
    if (p.x >= it.x && p.x <= it.x + it.w && p.y >= it.y && p.y <= it.y + it.h) return it;
  }
  return null;
}

function onDown(e) {
  if (e.button !== 0) return;
  const handle = e.target.dataset && e.target.dataset.h;
  const it = handle ? selectedItem() : hit(e);
  if (!it) { selectItem(null); updateOverlay(); return; }
  selectItem(it.id);
  updateOverlay();
  if (it.locked) return;
  const p = toBase(e);
  drag = {
    mode: handle ? 'resize' : 'move',
    handle,
    item: it,
    sx: p.x, sy: p.y,
    orig: { x: it.x, y: it.y, w: it.w, h: it.h, crop: { ...it.crop } },
    moved: false,
  };
  stage.setPointerCapture(e.pointerId);
}

function snapTargets(it) {
  const xs = [0, BASE_W / 2, BASE_W];
  const ys = [0, BASE_H / 2, BASE_H];
  for (const o of activeScene().items) {
    if (o === it || !o.visible) continue;
    xs.push(o.x, o.x + o.w / 2, o.x + o.w);
    ys.push(o.y, o.y + o.h / 2, o.y + o.h);
  }
  return { xs, ys };
}

function snapAxis(pos, size, targets, th) {
  // try left/center/right edges of the item against every target
  let best = null;
  for (const off of [0, size / 2, size]) {
    for (const t of targets) {
      const d = t - (pos + off);
      if (Math.abs(d) <= th && (best === null || Math.abs(d) < Math.abs(best.d))) best = { d, line: t };
    }
  }
  return best;
}

function onMove(e) {
  if (!drag) {
    const it = hit(e);
    stage.style.cursor = it && !it.locked ? 'move' : 'default';
    return;
  }
  const p = toBase(e);
  const dx = p.x - drag.sx;
  const dy = p.y - drag.sy;
  const it = drag.item;
  const o = drag.orig;
  if (!drag.moved && Math.hypot(dx, dy) * k < 2) return;
  drag.moved = true;

  if (drag.mode === 'move') {
    let nx = o.x + dx; let ny = o.y + dy;
    guideV.style.display = guideH.style.display = 'none';
    if (!e.ctrlKey) {
      const th = 8 / k;
      const t = snapTargets(it);
      const sx = snapAxis(nx, o.w, t.xs, th);
      const sy = snapAxis(ny, o.h, t.ys, th);
      if (sx) { nx += sx.d; guideV.style.left = `${sx.line * k}px`; guideV.style.display = 'block'; }
      if (sy) { ny += sy.d; guideH.style.top = `${sy.line * k}px`; guideH.style.display = 'block'; }
    }
    it.x = Math.round(nx); it.y = Math.round(ny);
  } else if (e.altKey) {
    cropDrag(it, o, drag.handle, dx, dy);
  } else {
    resizeDrag(it, o, drag.handle, dx, dy, e.shiftKey);
  }
  updateOverlay();
  emit('itemlive');
}

function resizeDrag(it, o, hd, dx, dy, free) {
  let { x, y, w, h } = o;
  const hasE = hd.includes('e'); const hasW = hd.includes('w');
  const hasN = hd.includes('n'); const hasS = hd.includes('s');
  if (hasE) w = o.w + dx;
  if (hasW) { x = o.x + dx; w = o.w - dx; }
  if (hasS) h = o.h + dy;
  if (hasN) { y = o.y + dy; h = o.h - dy; }
  const corner = hd.length === 2;
  if (corner && !free) {
    const ar = o.w / o.h;
    const sx = w / o.w; const sy = h / o.h;
    const s = Math.abs(sx - 1) > Math.abs(sy - 1) ? sx : sy;
    w = o.w * s; h = w / ar;
    if (hasW) x = o.x + o.w - w;
    if (hasN) y = o.y + o.h - h;
  }
  w = Math.max(8, w); h = Math.max(8, h);
  if (hasW) x = o.x + o.w - w;
  if (hasN) y = o.y + o.h - h;
  it.x = Math.round(x); it.y = Math.round(y); it.w = Math.round(w); it.h = Math.round(h);
}

function cropDrag(it, o, hd, dx, dy) {
  const res = getRes(it);
  if (!res || !res.width) return;
  const fullW = res.width; const fullH = res.height;
  const visW = fullW * (1 - o.crop.l - o.crop.r);
  const visH = fullH * (1 - o.crop.t - o.crop.b);
  const sx = o.w / visW; const sy = o.h / visH; // base px per source px
  const c = { ...o.crop };
  let { x, y, w, h } = o;
  const minPx = 8;
  if (hd.includes('w')) { const d = clamp(dx, -o.crop.l * fullW * sx, o.w - minPx); c.l = o.crop.l + d / sx / fullW; x = o.x + d; w = o.w - d; }
  if (hd.includes('e')) { const d = clamp(dx, -(o.w - minPx), o.crop.r * fullW * sx); c.r = o.crop.r - d / sx / fullW; w = o.w + d; }
  if (hd.includes('n')) { const d = clamp(dy, -o.crop.t * fullH * sy, o.h - minPx); c.t = o.crop.t + d / sy / fullH; y = o.y + d; h = o.h - d; }
  if (hd.includes('s')) { const d = clamp(dy, -(o.h - minPx), o.crop.b * fullH * sy); c.b = o.crop.b - d / sy / fullH; h = o.h + d; }
  c.l = clamp(c.l, 0, 0.95); c.r = clamp(c.r, 0, 0.95); c.t = clamp(c.t, 0, 0.95); c.b = clamp(c.b, 0, 0.95);
  it.crop = c;
  it.x = Math.round(x); it.y = Math.round(y); it.w = Math.round(w); it.h = Math.round(h);
}

function onUp(e) {
  if (!drag) return;
  try { stage.releasePointerCapture(e.pointerId); } catch { /* already released */ }
  guideV.style.display = guideH.style.display = 'none';
  const moved = drag.moved;
  drag = null;
  if (moved) { emit('items'); save(); }
}

function onKey(e) {
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
  if (document.querySelector('.modal-overlay')) return;
  const it = selectedItem();
  if (!it) return;
  const step = e.shiftKey ? 10 : 1;
  if (e.key === 'ArrowLeft') { nudge(-step, 0); e.preventDefault(); }
  else if (e.key === 'ArrowRight') { nudge(step, 0); e.preventDefault(); }
  else if (e.key === 'ArrowUp') { nudge(0, -step); e.preventDefault(); }
  else if (e.key === 'ArrowDown') { nudge(0, step); e.preventDefault(); }
  else if (e.key === 'Delete') { removeItem(it); e.preventDefault(); }
}

// Keep overlay in sync when the model changes elsewhere (list panel, properties, scene switch).
export function bindEvents(on) {
  on('items', updateOverlay);
  on('selection', updateOverlay);
}
