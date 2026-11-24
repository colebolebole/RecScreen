// DVD-logo-style bouncing V over the empty canvas. Constant velocity, wall reflections,
// springy squash & stretch on impact, a wobble spring, ghost trails and a corner-hit flash.
import { $ } from './util.js';

export function initVBounce() {
  const area = $('#preview-area');
  const root = $('#v-bounce');
  const empty = $('#stage-empty');
  if (!area || !root || !empty) return;
  const lead = root.querySelector('.vb-lead');
  const ghosts = [...root.querySelectorAll('.vb-ghost')];
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

  const SPEED = 150;
  let size = 90, x = 0, y = 0, vx = 0, vy = 0;
  let q = 0, qv = 0, axis = 'y';       // squash spring
  let tilt = 0, tv = 0;                // wobble spring
  let spin = 0, spinV = 0, spinTarget = 0; // click spin spring
  let raf = 0, last = 0, active = false, seeded = false;
  let lastBounceX = 0, lastBounceY = 0;
  const hist = [];
  const rand = (a, b) => a + Math.random() * (b - a);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  function seed() {
    const w = area.clientWidth, h = area.clientHeight;
    size = Math.round(clamp(Math.min(w, h) * 0.15, 64, 104));
    root.style.setProperty('--vbsz', `${size}px`);
    x = w * rand(0.3, 0.7); y = h * rand(0.25, 0.6);
    const a = rand(0, Math.PI * 2);
    vx = Math.cos(a) * SPEED; vy = Math.sin(a) * SPEED;
    if (Math.abs(vx) < 55) vx = Math.sign(vx || 1) * 55;
    if (Math.abs(vy) < 55) vy = Math.sign(vy || 1) * 55;
    const n = Math.hypot(vx, vy); vx = (vx / n) * SPEED; vy = (vy / n) * SPEED;
    q = 0; qv = 0; tilt = 0; tv = 0; hist.length = 0;
    seeded = true;
  }

  function ring(bright) {
    const r = document.createElement('div');
    r.className = `vb-ripple${bright ? ' bright' : ''}`;
    r.style.left = `${x}px`;
    r.style.top = `${y}px`;
    root.append(r);
    r.addEventListener('animationend', () => r.remove());
  }

  // Click the V: it shines and whips around itself with a springy overshoot.
  lead.addEventListener('click', () => {
    if (!active) return;
    root.classList.remove('shine');
    void root.offsetWidth;
    root.classList.add('shine');
    setTimeout(() => root.classList.remove('shine'), 800);
    ring(true);
    if (reduced) return;
    spinTarget += 360;
    qv += 3;
  });

  function kick(speed, ax, now) {
    axis = ax;
    qv += clamp(speed * 0.02, 1.5, 5.5);
    tv += rand(-110, 110);
    if (ax === 'x') lastBounceX = now; else lastBounceY = now;
    if (Math.abs(lastBounceX - lastBounceY) < 40 && lastBounceX && lastBounceY) {
      // Corner hit — the DVD holy grail.
      root.classList.remove('corner');
      void root.offsetWidth;
      root.classList.add('corner');
      tv += rand(-260, 260);
      setTimeout(() => root.classList.remove('corner'), 700);
      ring(false);
    }
  }

  function place(el, px, py, rot, sx, sy) {
    el.style.transform = `translate3d(${px - size / 2}px, ${py - size / 2}px, 0) rotate(${rot}deg) scale(${sx}, ${sy})`;
  }

  function frame(t) {
    raf = requestAnimationFrame(frame);
    const dt = clamp((t - last) / 1000, 0.001, 0.032);
    last = t;
    const w = area.clientWidth, h = area.clientHeight;
    const m = size / 2 + 8;

    x += vx * dt; y += vy * dt;
    if (x < m) { x = m; vx = Math.abs(vx); kick(Math.abs(vx), 'x', t); }
    else if (x > w - m) { x = w - m; vx = -Math.abs(vx); kick(Math.abs(vx), 'x', t); }
    if (y < m) { y = m; vy = Math.abs(vy); kick(Math.abs(vy), 'y', t); }
    else if (y > h - m) { y = h - m; vy = -Math.abs(vy); kick(Math.abs(vy), 'y', t); }

    // Underdamped springs: squash overshoots into stretch, wobble rings out.
    qv += (-230 * q - 10 * qv) * dt; q += qv * dt;
    const lean = clamp(vx * 0.03, -10, 10);
    tv += (-140 * (tilt - lean) - 9 * tv) * dt; tilt += tv * dt;
    spinV += (-90 * (spin - spinTarget) - 9 * spinV) * dt; spin += spinV * dt;
    const rot = tilt + spin;

    const st = 0.05; // slight stretch along the travel direction
    let sx = axis === 'x' ? 1 - q : 1 + q;
    let sy = axis === 'x' ? 1 + q : 1 - q;
    if (Math.abs(vy) > Math.abs(vx)) { sy += st; sx -= st * 0.6; } else { sx += st; sy -= st * 0.6; }

    place(lead, x, y, rot, sx, sy);
    hist.push({ x, y, tilt: rot });
    if (hist.length > 24) hist.shift();
    ghosts.forEach((g, i) => {
      const p = hist[Math.max(0, hist.length - 1 - (i + 1) * 6)];
      if (p) place(g, p.x, p.y, p.tilt, 1 - i * 0.05, 1 - i * 0.05);
    });
  }

  function start() {
    if (raf || reduced) return;
    if (!seeded) seed();
    last = performance.now();
    raf = requestAnimationFrame(frame);
  }
  function stop() { cancelAnimationFrame(raf); raf = 0; }

  function setActive(on) {
    if (on === active) return;
    active = on;
    root.classList.toggle('on', on);
    if (on) {
      if (reduced) {
        if (!seeded) seed();
        place(lead, area.clientWidth / 2, area.clientHeight * 0.3, -6, 1, 1);
      } else start();
    } else stop();
  }

  new MutationObserver(() => setActive(empty.classList.contains('show')))
    .observe(empty, { attributes: true, attributeFilter: ['class'] });
  setActive(empty.classList.contains('show'));

  new ResizeObserver(() => {
    if (!seeded) return;
    const m = size / 2 + 8;
    x = clamp(x, m, Math.max(m, area.clientWidth - m));
    y = clamp(y, m, Math.max(m, area.clientHeight - m));
    if (reduced && active) place(lead, area.clientWidth / 2, area.clientHeight * 0.3, -6, 1, 1);
  }).observe(area);

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stop();
    else if (active) start();
  });
}