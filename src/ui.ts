type Child = Node | string | number | null | undefined | false | Child[];
type Props = Record<string, unknown> & { class?: string; style?: string };

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props | null = null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k.startsWith('on') && typeof v === 'function') {
        el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
      } else if (k === 'class') el.className = v as string;
      else if (k === 'html') el.innerHTML = v as string;
      else if (k in el && typeof v !== 'string') (el as unknown as Record<string, unknown>)[k] = v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  append(el, children);
  return el;
}

function append(el: Node, children: Child[]) {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.appendChild(typeof c === 'object' ? c : document.createTextNode(String(c)));
  }
}

const ICONS: Record<string, string> = {
  camera: 'M9 3 7.2 5H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-3.2L15 3H9Zm3 5a5 5 0 1 1 0 10 5 5 0 0 1 0-10Zm0 2a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z',
  image: 'M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Zm0 13v3h14v-5l-4-4-6 6-2-2-2 2Zm3-9a2 2 0 1 0 0 4 2 2 0 0 0 0-4Z',
  back: 'M15.4 5.4 14 4l-8 8 8 8 1.4-1.4L8.8 12z',
  close: 'M18.3 5.7 17 4.3 12 9.3 7 4.3 5.7 5.7l5 5-5 5L7 17.1l5-5 5 5 1.4-1.4-5-5z',
  settings: 'M19.4 13a7.5 7.5 0 0 0 0-2l2.1-1.6-2-3.5-2.5 1a7 7 0 0 0-1.7-1L15 3h-4l-.4 2.9a7 7 0 0 0-1.7 1l-2.5-1-2 3.5L6.6 11a7.5 7.5 0 0 0 0 2l-2.1 1.6 2 3.5 2.5-1a7 7 0 0 0 1.7 1L11 21h4l.4-2.9a7 7 0 0 0 1.7-1l2.5 1 2-3.5-2.2-1.6ZM13 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7Z',
  pdf: 'M6 2h8l6 6v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Zm7 1.5V9h5.5L13 3.5ZM8 13v5h1.3v-1.6h.8a1.7 1.7 0 0 0 0-3.4H8Zm1.3 1.1h.7a.6.6 0 0 1 0 1.2h-.7v-1.2Zm3-1.1v5h1.5a2.5 2.5 0 0 0 0-5h-1.5Zm1.3 1.1h.2a1.4 1.4 0 0 1 0 2.8h-.2v-2.8Zm2.9-1.1v5h1.3v-2h1.7v-1.1h-1.7v-.8h1.9V13h-3.2Z',
  share: 'M18 16a3 3 0 0 0-2.4 1.2l-6.7-3.4a3 3 0 0 0 0-1.6l6.7-3.4A3 3 0 1 0 15 7l-6.7 3.4a3 3 0 1 0 0 3.2L15 17a3 3 0 1 0 3-1Z',
  text: 'M4 5h16v2H4zm0 4h16v2H4zm0 4h10v2H4zm0 4h16v2H4z',
  trash: 'M9 3h6l1 1h4v2H4V4h4l1-1Zm-3 5h12l-1 13H7L6 8Zm4 2v9h1.5v-9H10Zm3.5 0v9H15v-9h-1.5Z',
  rotl: 'M7.1 8.5 5.7 7.1A8 8 0 0 0 4 11h2a6 6 0 0 1 1.1-2.5ZM6 13H4a8 8 0 0 0 1.7 3.9l1.4-1.4A6 6 0 0 1 6 13Zm1.1 5.3A8 8 0 0 0 11 20v-2a6 6 0 0 1-2.5-1.1l-1.4 1.4ZM13 4.1V1L8.5 5.5 13 10V6.1A6 6 0 0 1 13 18v2a8 8 0 0 0 0-15.9Z',
  rotr: 'M15.5 5.5 11 1v3.1A8 8 0 0 0 11 20v-2a6 6 0 0 1 0-11.9V10l4.5-4.5Zm4.4 5.5a8 8 0 0 0-1.6-3.9l-1.4 1.4A6 6 0 0 1 17.9 11h2Zm-6.9 6.9V20a8 8 0 0 0 3.9-1.6l-1.4-1.4a6 6 0 0 1-2.5 1Zm3.9-2.5 1.4 1.4A8 8 0 0 0 19.9 13h-2a6 6 0 0 1-1.1 2.4Z',
  crop: 'M17 15h2V7a2 2 0 0 0-2-2H9v2h8v8ZM7 17V1H5v4H1v2h4v10a2 2 0 0 0 2 2h10v4h2v-4h4v-2H7Z',
  ocr: 'M3 5v4h2V5h4V3H5a2 2 0 0 0-2 2Zm2 10H3v4a2 2 0 0 0 2 2h4v-2H5v-4Zm14 4h-4v2h4a2 2 0 0 0 2-2v-4h-2v4Zm0-16h-4v2h4v4h2V5a2 2 0 0 0-2-2ZM7 8h10v2H7zm0 3h10v2H7zm0 3h7v2H7z',
  copy: 'M16 1H4a2 2 0 0 0-2 2v14h2V3h12V1Zm3 4H8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2Zm0 16H8V7h11v14Z',
  plus: 'M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2Z',
  check: 'M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4L9 16.2Z',
  flash: 'M7 2v11h3v9l7-12h-4l4-8H7Z',
  auto: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm-1 5h2l3.5 10h-2.1l-.8-2.4h-3.2L9.6 17H7.5L11 7Zm1 2.6-1 3.2h2l-1-3.2Z',
  left: 'M15.4 7.4 14 6l-6 6 6 6 1.4-1.4L10.8 12z',
  right: 'M8.6 16.6 10 18l6-6-6-6-1.4 1.4 4.6 4.6z',
  search: 'M15.5 14h-.8l-.3-.3A6.5 6.5 0 1 0 14 15.5l.3.3v.8l5 5 1.5-1.5-5-5Zm-6 0a4.5 4.5 0 1 1 0-9 4.5 4.5 0 0 1 0 9Z',
  edit: 'M3 17.2V21h3.8l11-11-3.8-3.8-11 11ZM20.7 7a1 1 0 0 0 0-1.4l-2.3-2.3a1 1 0 0 0-1.4 0l-1.8 1.8 3.7 3.7L20.7 7Z',
  boxes: 'M3 3h8v8H3V3Zm2 2v4h4V5H5Zm8-2h8v8h-8V3Zm2 2v4h4V5h-4ZM3 13h8v8H3v-8Zm2 2v4h4v-4H5Zm8-2h8v8h-8v-8Zm2 2v4h4v-4h-4Z',
};

export function icon(name: keyof typeof ICONS | string, size = 24): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('icon');
  const p = document.createElementNS(ns, 'path');
  p.setAttribute('d', ICONS[name] ?? '');
  p.setAttribute('fill', 'currentColor');
  svg.appendChild(p);
  return svg;
}

export function iconButton(name: string, label: string, onClick: (e: Event) => void, cls = ''): HTMLButtonElement {
  return h('button', { class: `icon-btn ${cls}`, 'aria-label': label, title: label, onClick }, icon(name));
}

export function actionButton(name: string, label: string, onClick: (e: Event) => void, cls = ''): HTMLButtonElement {
  return h('button', { class: `action-btn ${cls}`, onClick }, icon(name, 22), h('span', null, label));
}

let toastTimer = 0;
export function toast(msg: string, ms = 2600): void {
  let el = document.getElementById('toast');
  if (!el) {
    el = h('div', { id: 'toast', role: 'status', 'aria-live': 'polite' });
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el!.classList.remove('show'), ms);
}

export function confirmDialog(message: string, okLabel = 'Delete'): Promise<boolean> {
  return new Promise((resolve) => {
    const close = (v: boolean) => {
      overlay.remove();
      resolve(v);
    };
    const overlay = h(
      'div',
      { class: 'modal-backdrop', onClick: (e: Event) => e.target === overlay && close(false) },
      h(
        'div',
        { class: 'modal', role: 'dialog', 'aria-modal': 'true' },
        h('p', null, message),
        h(
          'div',
          { class: 'modal-actions' },
          h('button', { class: 'btn', onClick: () => close(false) }, 'Cancel'),
          h('button', { class: 'btn danger', onClick: () => close(true) }, okLabel),
        ),
      ),
    );
    document.body.appendChild(overlay);
  });
}

export function promptDialog(title: string, value: string): Promise<string | null> {
  return new Promise((resolve) => {
    const input = h('input', { class: 'input', value, 'aria-label': title });
    const close = (v: string | null) => {
      overlay.remove();
      resolve(v);
    };
    const form = h(
      'form',
      {
        class: 'modal',
        onSubmit: (e: Event) => {
          e.preventDefault();
          close(input.value.trim() || null);
        },
      },
      h('h3', null, title),
      input,
      h(
        'div',
        { class: 'modal-actions' },
        h('button', { class: 'btn', type: 'button', onClick: () => close(null) }, 'Cancel'),
        h('button', { class: 'btn primary', type: 'submit' }, 'Save'),
      ),
    );
    const overlay = h('div', { class: 'modal-backdrop' }, form);
    document.body.appendChild(overlay);
    input.focus();
    input.select();
  });
}

/** Blocking progress overlay. */
export function progressOverlay(label: string) {
  const bar = h('div', { class: 'progress-bar' });
  const text = h('p', null, label);
  const el = h('div', { class: 'modal-backdrop' }, h('div', { class: 'modal progress-modal' }, text, h('div', { class: 'progress' }, bar)));
  document.body.appendChild(el);
  return {
    update(p: number, l?: string) {
      bar.style.width = `${Math.round(Math.min(1, Math.max(0, p)) * 100)}%`;
      if (l) text.textContent = l;
    },
    close: () => el.remove(),
  };
}

export function formatDate(t: number): string {
  return new Date(t).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function pickFiles(accept = 'image/*', multiple = true): Promise<File[]> {
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', accept, multiple, style: 'display:none' });
    input.addEventListener('change', () => {
      resolve(Array.from(input.files ?? []));
      input.remove();
    });
    document.body.appendChild(input);
    input.click();
  });
}
