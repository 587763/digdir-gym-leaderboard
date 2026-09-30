// Shared DOM helpers: auto-escaping HTML templates, native modal dialogs and toasts.
window.UI = (() => {
  const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  // Escapes text for element content and quoted attributes alike.
  const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ESCAPES[c]);

  // Markup that is known to be safe. Only html`` results and raw() produce it.
  class SafeHtml {
    constructor(value) { this.value = value; }
    toString() { return this.value; }
  }
  const raw = (markup) => new SafeHtml(String(markup));
  const fragment = (value) => value instanceof SafeHtml ? value.value
    : Array.isArray(value) ? value.map(fragment).join('')
    : value == null || value === false ? '' : escapeHtml(value);
  // Every interpolation is escaped unless it is itself html`` / raw(); arrays are joined,
  // and null, undefined and false render nothing (so `${cond && html`…`}` works).
  const html = (strings, ...values) => new SafeHtml(strings.reduce((out, s, i) => out + fragment(values[i - 1]) + s));

  // --- dates -----------------------------------------------------------------
  // The interface is English; dates read day-month-year as they do in the office.
  const LOCALE = 'en-GB';
  const formatDate = (iso) => iso
    ? new Date(iso).toLocaleDateString(LOCALE, { day: 'numeric', month: 'short', year: 'numeric' }) : '';
  const UNITS = [['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60]];
  // "just now", "yesterday", "3 days ago".
  function timeAgo(iso, now = Date.now()) {
    const seconds = (Date.parse(iso) - now) / 1000;
    if (!Number.isFinite(seconds)) return '';
    if (Math.abs(seconds) < 60) return 'just now';
    const [unit, size] = UNITS.find(([, s]) => Math.abs(seconds) >= s);
    return new Intl.RelativeTimeFormat(LOCALE, { numeric: 'auto' }).format(Math.round(seconds / size), unit);
  }

  // --- dialogs ---------------------------------------------------------------
  // showModal() makes the page inert, traps focus and closes on Escape. We add
  // backdrop clicks and focus restoration that survives re-renders; the page's
  // scroll lock is pure CSS (body:has(dialog[open])), so it can never get stuck.
  let trigger = null, triggerScope = null;
  const listeners = new Set();
  const dialogs = () => [...document.querySelectorAll('dialog.modal')];
  const openDialog = () => dialogs().find((d) => d.open) || null;

  // Where a control lives: its board, feed, Hall of Fame or dialog. The same athlete's
  // name button appears on several boards, so twins are only looked for in that scope.
  function scopeOf(el) {
    const scope = el?.closest?.('[data-lift], [data-feed], #hallOfFame, dialog');
    return !scope ? null : scope.dataset.lift ? `[data-lift="${scope.dataset.lift}"]`
      : scope.dataset.feed ? `[data-feed="${scope.dataset.feed}"]` : `#${scope.id}`;
  }

  // After a re-render, the control that replaced `el`: same data-action and data-id.
  function twinOf(el, scope) {
    if (!el || el.isConnected) return el;
    const action = el.dataset?.action;
    if (!action) return null;
    const root = (scope && document.querySelector(scope)) || document;
    const twins = [...root.querySelectorAll(`[data-action="${action}"]`)].filter((c) => c.dataset.id === el.dataset.id);
    return twins.find((c) => c.getClientRects?.().length) || twins[0] || null;
  }

  // Re-render without losing the visitor's place: refocus the replaced control, or
  // the dialog it was in when it disappeared (e.g. an approved review item).
  function keepFocus(render) {
    const focused = document.activeElement;
    const scope = scopeOf(focused);
    const dialog = focused?.closest?.('dialog');
    render();
    if (!focused || focused === document.body || focused.isConnected) return;
    (twinOf(focused, scope) || (dialog?.open && dialog.querySelector('.modal-content')))?.focus({ preventScroll: true });
  }

  function restoreFocus() {
    const previous = trigger;
    trigger = null;
    (twinOf(previous, triggerScope) || document.querySelector('.tab-btn.active'))?.focus();
  }

  // Live region for toasts. A modal dialog sits in the browser's top layer, so each
  // dialog gets its own region; otherwise toasts would render behind the backdrop.
  function toastRegion(host) {
    let region = [...host.children].find((el) => el.classList.contains('toast-region'));
    if (!region) {
      region = document.createElement('div');
      region.className = 'toast-region';
      region.setAttribute('aria-live', 'polite');
      host.appendChild(region);
    }
    return region;
  }

  function setup() {
    toastRegion(document.body);
    for (const dialog of dialogs()) {
      toastRegion(dialog);
      // Close on backdrop clicks, but not when a text selection drag ends there.
      let pressedBackdrop = false;
      dialog.addEventListener('pointerdown', (event) => { pressedBackdrop = event.target === dialog; });
      dialog.addEventListener('click', (event) => {
        if (pressedBackdrop && event.target === dialog) dialog.close();
        pressedBackdrop = false;
      });
      dialog.addEventListener('close', () => {
        if (openDialog()) return; // another dialog replaced this one
        restoreFocus();
        listeners.forEach((fn) => fn(false));
      });
    }
  }

  function open(id) {
    const dialog = document.getElementById(id);
    const current = openDialog();
    if (current === dialog) return dialog;
    if (current) { current.close(); } else { trigger = document.activeElement; triggerScope = scopeOf(trigger); }
    dialog.showModal();
    (dialog.querySelector('[autofocus]') || dialog).focus();
    if (!current) listeners.forEach((fn) => fn(true));
    return dialog;
  }
  const close = (id) => { const dialog = document.getElementById(id); if (dialog?.open) dialog.close(); };
  const closeAll = () => dialogs().forEach((d) => { if (d.open) d.close(); });
  const isOpen = (id) => !!document.getElementById(id)?.open;

  // --- toasts ----------------------------------------------------------------
  // type: 'success' | 'error' (role=alert) | 'celebrate' (a verified PR, stays longest
  // so people glancing at the office TV still catch it). A new toast replaces the last.
  const TOAST_MS = { success: 4000, error: 7000, celebrate: 10000 };
  function toast(message, type = 'success') {
    document.querySelectorAll('.toast').forEach((el) => el.remove());
    const item = document.createElement('div');
    item.className = `toast ${type}`;
    if (type === 'error') item.setAttribute('role', 'alert');
    item.textContent = message;
    toastRegion(openDialog() || document.body).appendChild(item);
    setTimeout(() => {
      item.classList.add('leaving');
      setTimeout(() => item.remove(), 300);
    }, TOAST_MS[type] ?? TOAST_MS.success);
  }

  return {
    escapeHtml, html, raw, SafeHtml, toast, keepFocus, formatDate, timeAgo,
    dialogs: { setup, open, close, closeAll, isOpen, anyOpen: () => !!openDialog(), onChange: (fn) => listeners.add(fn) },
  };
})();
