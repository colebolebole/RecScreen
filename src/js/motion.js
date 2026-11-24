// Motion toolkit: FLIP list transitions, content swaps, staggered menus, toast reflow.
// Everything is transform/opacity only and gated on prefers-reduced-motion.
export const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
export const SPRING = 'cubic-bezier(.34, 1.56, .64, 1)';
export const SPRING_SOFT = 'cubic-bezier(.22, 1.2, .36, 1)';

/**
 * FLIP a keyed list: render() rebuilds the children; survivors glide to their new
 * spots, newcomers rise in, and removed rows ghost out in place.
 * Keys come from el.dataset.flipKey (set by the renderer).
 */
export function flipList(list, render) {
  const before = new Map();
  if (!reduced) for (const el of list.children) {
    if (el.dataset.flipKey) before.set(el.dataset.flipKey, { rect: el.getBoundingClientRect(), el });
  }
  render();
  if (reduced) return;
  let enter = 0;
  for (const el of list.children) {
    const k = el.dataset.flipKey;
    if (!k) continue;
    const b = before.get(k);
    if (b) {
      before.delete(k);
      const a = el.getBoundingClientRect();
      const dx = b.rect.left - a.left, dy = b.rect.top - a.top;
      if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
        el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }],
          { duration: 340, easing: SPRING_SOFT });
      }
    } else {
      el.animate([{ opacity: 0, transform: 'translateY(7px) scale(.96)' }, { opacity: 1, transform: 'none' }],
        { duration: 300, easing: SPRING_SOFT, delay: Math.min(enter++ * 30, 180), fill: 'backwards' });
    }
  }
  for (const { rect, el } of before.values()) {
    const ghost = el.cloneNode(true);
    ghost.style.cssText = `position:fixed;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px;margin:0;z-index:1500;pointer-events:none;`;
    document.body.append(ghost);
    ghost.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateX(14px) scale(.94)' }],
      { duration: 220, easing: 'ease-in' }).finished.then(() => ghost.remove(), () => ghost.remove());
  }
}

/** Replace a control's innerHTML; animate the new content in only when `animate` is set. */
export function swapHTML(el, html, animate) {
  if (el.innerHTML === html) return;
  el.innerHTML = html;
  if (animate && !reduced) {
    el.animate([{ opacity: 0.3, transform: 'translateY(4px) scale(.97)' }, { opacity: 1, transform: 'none' }],
      { duration: 240, easing: SPRING_SOFT });
  }
}

/** Cascade a context menu's items in. */
export function staggerMenu(menu) {
  if (reduced) return;
  let i = 0;
  for (const el of menu.children) {
    if (el.classList.contains('ctx-sep')) continue;
    el.animate([{ opacity: 0, transform: 'translateX(-5px)' }, { opacity: 1, transform: 'none' }],
      { duration: 200, easing: SPRING_SOFT, delay: Math.min(i++ * 16, 140), fill: 'backwards' });
  }
}