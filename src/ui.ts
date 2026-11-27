import {
  createElement, AlignLeft, ArrowLeft, ArrowRight, Camera, Check, ChevronLeft, ChevronRight, Clock3, Copy,
  Crop, Download, EllipsisVertical, FileStack, FileText, Focus, FolderOpen, Images, Languages, PenLine,
  Plus, RotateCcw, RotateCw, ScanLine, ScanSearch, ScanText, Search, Settings, Share2, ShieldCheck,
  Sparkles, Trash2, X, Zap, CloudUpload, Cloud, CloudOff, LockKeyhole, KeyRound, Server, QrCode, Eye,
  EyeOff, RefreshCw, LogOut, CircleCheck, CircleAlert, Delete, Smartphone, Hash, ShieldAlert, type IconNode,
} from 'lucide';

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

const ICONS: Record<string, IconNode> = {
  camera: Camera, scan: ScanLine, image: Images, back: ChevronLeft, close: X, settings: Settings,
  pdf: FileText, share: Share2, text: AlignLeft, trash: Trash2, rotl: RotateCcw, rotr: RotateCw,
  crop: Crop, ocr: ScanText, copy: Copy, plus: Plus, check: Check, flash: Zap, auto: Focus,
  left: ArrowLeft, right: ArrowRight, search: Search, edit: PenLine, boxes: ScanSearch,
  download: Download, more: EllipsisVertical, languages: Languages, shield: ShieldCheck,
  sparkles: Sparkles, pages: FileStack, folder: FolderOpen, clock: Clock3, chevron: ChevronRight,
  upload: CloudUpload, cloud: Cloud, cloudoff: CloudOff, lock: LockKeyhole, key: KeyRound, server: Server,
  qr: QrCode, eye: Eye, eyeoff: EyeOff, refresh: RefreshCw, logout: LogOut, ok: CircleCheck,
  alert: CircleAlert, delete: Delete, phone: Smartphone, hash: Hash, shieldalert: ShieldAlert,
};

/** WhatsApp brand glyph (filled); Lucide has no brand icons. */
const WHATSAPP_PATH = 'M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2Zm0 18.2c-1.5 0-3-.4-4.3-1.2l-.3-.2-3 .8.8-2.9-.2-.3A8.2 8.2 0 1 1 12 20.2Zm4.5-6.1c-.2-.1-1.5-.7-1.7-.8-.2-.1-.4-.1-.6.1l-.8 1c-.1.2-.3.2-.5.1a6.7 6.7 0 0 1-3.3-2.9c-.3-.4.2-.4.7-1.4.1-.2 0-.3 0-.5l-.8-1.8c-.2-.5-.4-.4-.6-.4h-.5a1 1 0 0 0-.7.3 3 3 0 0 0-.9 2.2 5.2 5.2 0 0 0 1.1 2.7c.1.2 1.9 2.8 4.5 3.9 1.7.7 2.3.8 3.2.7.5-.1 1.5-.6 1.8-1.2.2-.6.2-1.1.1-1.2l-.5-.3Z';

export function icon(name: string, size = 24): SVGElement {
  let svg: SVGElement;
  if (name === 'whatsapp') {
    const ns = 'http://www.w3.org/2000/svg';
    svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    const p = document.createElementNS(ns, 'path');
    p.setAttribute('d', WHATSAPP_PATH);
    p.setAttribute('fill', 'currentColor');
    svg.appendChild(p);
  } else {
    svg = createElement(ICONS[name] ?? ICONS.sparkles, { 'stroke-width': 1.9 });
  }
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('icon');
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

export interface SheetOption {
  label: string;
  icon: string;
  hint?: string;
  danger?: boolean;
}

/** Bottom action sheet; resolves with the chosen index or null. */
export function actionSheet(title: string, options: SheetOption[]): Promise<number | null> {
  return new Promise((resolve) => {
    const close = (v: number | null) => {
      overlay.classList.remove('open');
      setTimeout(() => overlay.remove(), 180);
      resolve(v);
    };
    const overlay = h(
      'div',
      { class: 'sheet-backdrop', onClick: (e: Event) => e.target === overlay && close(null) },
      h(
        'div',
        { class: 'sheet', role: 'dialog', 'aria-label': title },
        h('div', { class: 'sheet-grip' }),
        h('h3', null, title),
        options.map((o, i) =>
          h(
            'button',
            { class: `sheet-item ${o.danger ? 'danger' : ''}`, onClick: () => close(i) },
            icon(o.icon, 24),
            h('span', null, h('strong', null, o.label), o.hint && h('small', null, o.hint)),
          ),
        ),
        h('button', { class: 'btn sheet-cancel', onClick: () => close(null) }, 'Cancel'),
      ),
    );
    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add('open'));
  });
}
