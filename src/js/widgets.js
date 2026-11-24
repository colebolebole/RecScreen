// Small UI toolkit: modal dialogs, toasts, context menus, form helpers.
import { h, $ } from './util.js';
import { icon } from './icons.js';
import { staggerMenu } from './motion.js';

/* ---------------- Modal ---------------- */
export function modal({ title, body, buttons, width = 560, onClose, onOpen, dismissible = true, className = '' }) {
  return new Promise((resolve) => {
    const root = $('#modal-root');
    const overlay = h('div', { class: 'modal-overlay' });
    const box = h('div', { class: `modal ${className}`, style: { width: `${width}px` }, role: 'dialog', 'aria-label': title });
    let closed = false;
    const close = (val) => {
      if (closed) return;
      closed = true;
      document.removeEventListener('keydown', onKey, true);
      // Play the exit animation, then detach.
      overlay.classList.add('closing');
      setTimeout(() => overlay.remove(), 170);
      if (onClose) onClose();
      resolve(val);
    };
    const head = h('div', { class: 'modal-head' }, h('span', {}, title),
      dismissible ? h('button', { class: 'icon-btn', title: 'Close', html: icon('close'), onclick: () => close(null) }) : null);
    const foot = h('div', { class: 'modal-foot' });
    for (const b of buttons || []) {
      const btn = h('button', {
        class: `btn ${b.primary ? 'primary' : ''} ${b.danger ? 'danger' : ''}`,
        onclick: async () => {
          if (b.onClick) { const keep = await b.onClick(box); if (keep === false) return; }
          close(b.value ?? b.label);
        },
      }, b.label);
      foot.append(btn);
    }
    box.append(head, h('div', { class: 'modal-body' }, body));
    if (buttons && buttons.length) box.append(foot);
    overlay.append(box);
    overlay.addEventListener('pointerdown', (e) => { if (dismissible && e.target === overlay) close(null); });
    function onKey(e) {
      if (e.key === 'Escape') { e.stopPropagation(); if (dismissible) close(null); }
      else if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA' && e.target.tagName !== 'BUTTON' && e.target.tagName !== 'SELECT') {
        const p = foot.querySelector('.btn.primary');
        if (p) { e.preventDefault(); p.click(); }
      }
    }
    document.addEventListener('keydown', onKey, true);
    root.append(overlay);
    const first = box.querySelector('input:not([type=checkbox]):not([type=color]), textarea, select');
    if (first) { first.focus(); if (first.select && first.tagName === 'INPUT') first.select(); }
    if (onOpen) onOpen({ close, box, foot });
  });
}

export async function confirmBox(title, message, okLabel = 'OK', danger = false) {
  const r = await modal({
    title,
    width: 420,
    body: h('p', { class: 'confirm-text' }, message),
    buttons: [{ label: 'Cancel', value: false }, { label: okLabel, primary: true, danger, value: true }],
  });
  return r === true;
}

export async function promptBox(title, label, value = '', okLabel = 'OK') {
  const input = h('input', { type: 'text', value, class: 'text-input' });
  const r = await modal({
    title,
    width: 400,
    body: h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), input),
    buttons: [{ label: 'Cancel', value: null }, { label: okLabel, primary: true, value: 'ok' }],
  });
  return r === 'ok' ? input.value.trim() : null;
}

/* ---------------- Notifications: status-bar ticker + notification center ---------------- */
const KIND_ICON = { info: 'info', success: 'check', warn: 'alert', error: 'alert' };
const history = [];
let unread = 0, panelEl = null, tickerTimer = null;

function badge() {
  const b = $('#notif-badge');
  if (!b) return;
  b.hidden = unread === 0;
  b.textContent = unread > 9 ? '9+' : String(unread);
}

function ago(t) {
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

function showTicker(entry, timeout) {
  const el = $('#ticker');
  if (!el) return;
  clearTimeout(tickerTimer);
  el.hidden = false;
  el.className = entry.kind;
  el.replaceChildren(
    h('span', { class: 'tick-ic', html: icon(KIND_ICON[entry.kind] || 'info', 13) }),
    h('span', { class: 'tick-msg', title: entry.msg }, entry.msg),
    ...entry.actions.slice(0, 2).map((a) => h('button', { class: 'tick-act', onclick: () => { a.onClick(); dismissTicker(); } }, a.label)),
    h('button', { class: 'tick-x', title: 'Dismiss', html: icon('close', 11), onclick: () => dismissTicker() }),
  );
  el.classList.remove('in');
  void el.offsetWidth;
  el.classList.add('in');
  const arm = () => { if (timeout) tickerTimer = setTimeout(dismissTicker, timeout); };
  el.onmouseenter = () => clearTimeout(tickerTimer);
  el.onmouseleave = arm;
  arm();
}

function dismissTicker() {
  clearTimeout(tickerTimer);
  const el = $('#ticker');
  if (!el || el.hidden) return;
  el.classList.add('out');
  setTimeout(() => { el.hidden = true; el.classList.remove('out', 'in'); }, 200);
}

function renderPanel() {
  if (!panelEl) return;
  const list = panelEl.querySelector('.notif-list');
  list.replaceChildren();
  if (!history.length) list.append(h('div', { class: 'notif-empty' }, 'No notifications yet.'));
  for (const e of history) {
    list.append(h('div', { class: `notif-item ${e.kind}` },
      h('span', { class: 'notif-ic', html: icon(KIND_ICON[e.kind] || 'info', 14) }),
      h('div', { class: 'notif-body' },
        h('div', { class: 'notif-msg' }, e.msg),
        h('div', { class: 'notif-meta' }, ago(e.at)),
        e.actions.length ? h('div', { class: 'notif-acts' }, ...e.actions.map((a) => h('button', { class: 'tick-act', onclick: () => a.onClick() }, a.label))) : null),
    ));
  }
}

function closePanel() {
  if (!panelEl) return;
  const el = panelEl;
  panelEl = null;
  el.classList.add('closing');
  setTimeout(() => el.remove(), 120);
  document.removeEventListener('pointerdown', outside, true);
}
function outside(e) { if (panelEl && !panelEl.contains(e.target) && !e.target.closest('#btn-notifs')) closePanel(); }

function openPanel() {
  const btn = $('#btn-notifs');
  const r = btn.getBoundingClientRect();
  panelEl = h('div', { class: 'notif-panel' },
    h('div', { class: 'notif-head' }, h('span', {}, 'Notifications'),
      h('button', { class: 'tick-act', onclick: () => { history.length = 0; renderPanel(); } }, 'Clear all')),
    h('div', { class: 'notif-list' }));
  document.body.append(panelEl);
  const w = panelEl.getBoundingClientRect().width;
  panelEl.style.left = `${Math.max(6, Math.min(r.right - w, innerWidth - w - 6))}px`;
  panelEl.style.top = `${r.bottom + 6}px`;
  unread = 0;
  badge();
  renderPanel();
  setTimeout(() => document.addEventListener('pointerdown', outside, true));
}

export function initNotifications() {
  const btn = $('#btn-notifs');
  if (btn) btn.onclick = () => (panelEl ? closePanel() : openPanel());
}

/** Non-blocking notification: one line in the status bar, full text + actions in the center. */
export function toast(message, { kind = 'info', actions = [], timeout = 5000 } = {}) {
  const entry = { msg: message, kind, actions, at: Date.now() };
  history.unshift(entry);
  if (history.length > 30) history.pop();
  if (panelEl) renderPanel();
  else { unread++; badge(); }
  showTicker(entry, timeout);
  return dismissTicker;
}

/* ---------------- Context menu ---------------- */
let ctxEl = null;
export function closeMenu() {
  if (!ctxEl) return;
  const el = ctxEl;
  ctxEl = null;
  el.classList.add('closing');
  el.style.pointerEvents = 'none';
  setTimeout(() => el.remove(), 110);
}

export function contextMenu(x, y, items, { anchorRight = false } = {}) {
  closeMenu();
  const el = h('div', { class: 'ctx-menu', role: 'menu' });
  for (const it of items) {
    if (it.separator) { el.append(h('div', { class: 'ctx-sep' })); continue; }
    if (it.header) { el.append(h('div', { class: 'ctx-header' }, it.header)); continue; }
    const row = h('div', {
      class: `ctx-item ${it.disabled ? 'disabled' : ''}`,
      role: 'menuitem',
      onclick: (e) => {
        e.stopPropagation();
        if (it.disabled) return;
        closeMenu();
        if (it.onClick) it.onClick();
      },
    },
    h('span', { class: 'ctx-check', html: it.checked ? icon('check', 14) : (it.icon ? icon(it.icon, 14) : '') }),
    h('span', { class: 'ctx-label' }, it.label),
    h('span', { class: 'ctx-hint' }, it.hint || ''));
    el.append(row);
  }
  document.body.append(el);
  staggerMenu(el);
  const r = el.getBoundingClientRect();
  let px = anchorRight ? x - r.width : x;
  let py = y;
  if (px + r.width > innerWidth - 6) px = innerWidth - r.width - 6;
  if (py + r.height > innerHeight - 6) py = Math.max(6, y - r.height);
  el.style.left = `${Math.max(6, px)}px`;
  el.style.top = `${py}px`;
  ctxEl = el;
  setTimeout(() => {
    const off = (e) => { if (!el.contains(e.target)) { closeMenu(); document.removeEventListener('pointerdown', off, true); } };
    document.addEventListener('pointerdown', off, true);
  });
}

/* ---------------- Form helpers ---------------- */
export function field(label, control, hint) {
  return h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), control, hint ? h('span', { class: 'field-hint' }, hint) : null);
}

export function select(options, value, onChange) {
  const el = h('select', { class: 'select' });
  for (const o of options) {
    const opt = h('option', { value: o.value }, o.label);
    if (String(o.value) === String(value)) opt.selected = true;
    el.append(opt);
  }
  if (onChange) el.addEventListener('change', () => onChange(el.value));
  return el;
}

export function checkbox(label, checked, onChange) {
  const cb = h('input', { type: 'checkbox' });
  cb.checked = !!checked;
  if (onChange) cb.addEventListener('change', () => onChange(cb.checked));
  const wrap = h('label', { class: 'check' }, cb, h('span', {}, label));
  wrap.input = cb;
  return wrap;
}

export function numberInput(value, { min, max, step = 1, onChange } = {}) {
  const el = h('input', { type: 'number', class: 'text-input', value, min, max, step });
  if (onChange) el.addEventListener('input', () => onChange(Number(el.value)));
  return el;
}

/**
 * Segmented control (pill switch with a sliding indicator).
 * options: [{ value, label, disabled?, title? }]. Returns the element with .value getter/setter.
 */
export function segmented(options, value, onChange) {
  const el = h('div', { class: 'seg', role: 'radiogroup' });
  const pill = h('span', { class: 'seg-pill', 'aria-hidden': 'true' });
  el.append(pill);
  const btns = options.map((o) => {
    const b = h('button', {
      type: 'button', class: 'seg-btn', role: 'radio', title: o.title || '', disabled: !!o.disabled,
      onclick: () => { if (cur !== o.value) { set(o.value); if (onChange) onChange(o.value); } },
    }, o.label);
    b.dataset.value = o.value;
    el.append(b);
    return b;
  });
  let cur = value;
  const place = () => {
    const b = btns.find((x) => x.dataset.value === String(cur));
    if (!b || !b.offsetWidth) { pill.style.opacity = b ? '1' : '0'; return; }
    pill.style.opacity = '1';
    pill.style.width = `${b.offsetWidth}px`;
    pill.style.transform = `translateX(${b.offsetLeft}px)`;
  };
  const set = (v) => {
    cur = v;
    btns.forEach((b) => { const on = b.dataset.value === String(v); b.classList.toggle('active', on); b.setAttribute('aria-checked', on); });
    place();
  };
  set(value);
  // Measure once laid out (dialogs mount after creation) and whenever the control resizes.
  new ResizeObserver(place).observe(el);
  Object.defineProperty(el, 'value', { get: () => cur, set });
  return el;
}

/** Wrapper whose content smoothly expands / collapses (animates grid rows 0fr <-> 1fr). */
export function collapsible(content, open = true) {
  const el = h('div', { class: `collapse ${open ? 'open' : ''}` }, h('div', { class: 'collapse-inner' }, content));
  el.setOpen = (v) => el.classList.toggle('open', !!v);
  return el;
}
