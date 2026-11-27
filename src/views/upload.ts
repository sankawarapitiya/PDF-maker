import { getSettings } from '../db';
import { navigate } from '../router';
import { docIdError, getSession, UploadError } from '../server';
import { hasSecret } from '../vault';
import { SECRET_TOKEN } from '../server';
import { queueUpload, uploadEvents, type UploadEvent } from '../uploads';
import { h, icon, toast } from '../ui';
import { barcodeSupported, scanBarcode } from './barcode';
import type { Doc } from '../types';

/** Bottom-sheet dialog: enter / scan the doc-ID and send the document to the server. */
export async function openUploadDialog(doc: Doc): Promise<void> {
  const settings = await getSettings();
  const s = settings.server;
  const signedIn = s.authMethod === 'token' ? await hasSecret(SECRET_TOKEN) : !!(await getSession());

  if (!s.enabled || !s.url || !signedIn) {
    return sheet(
      h('div', { class: 'upload-empty' },
        h('div', { class: 'upload-icon' }, icon('server', 28)),
        h('h3', null, !s.enabled || !s.url ? 'Connect a server first' : 'Sign in to your server'),
        h('p', { class: 'muted' }, 'Set the server address and your credentials in Settings → Server upload.'),
        h('button', { class: 'btn primary', onClick: () => { closeSheet(); navigate('/settings/server'); } }, icon('settings', 20), 'Open settings')),
    );
  }

  const input = h('input', {
    class: 'input docid-input', value: doc.remoteDocId ?? '', placeholder: 'e.g. INV-2048',
    autocomplete: 'off', autocapitalize: 'characters', spellcheck: false, 'aria-label': 'Doc-ID', inputMode: 'text',
    onInput: () => validate(),
  });
  const err = h('small', { class: 'field-error', role: 'alert' });
  const includeText = h('input', { type: 'checkbox', checked: s.includeText });
  const progressBar = h('div', { class: 'progress-bar' });
  const progress = h('div', { class: 'progress', hidden: true }, progressBar);
  const status = h('p', { class: 'upload-status muted' });
  const sendBtn = h('button', { class: 'btn primary upload-send', onClick: () => send() }, icon('upload', 20), 'Upload');
  const scanBtn = h('button', { class: 'icon-btn scan-id', 'aria-label': 'Scan doc-ID barcode', hidden: true, onClick: async () => {
    const v = await scanBarcode();
    if (v) { input.value = v; validate(); }
  } }, icon('qr'));
  barcodeSupported().then((ok) => (scanBtn.hidden = !ok));

  function validate(): boolean {
    const e = input.value ? docIdError(input.value, s.docIdPattern) : null;
    err.textContent = e ?? '';
    input.classList.toggle('invalid', !!e);
    return !e && !!input.value.trim();
  }

  const onEvent = (e: Event) => {
    const d = (e as CustomEvent<UploadEvent>).detail;
    if (d.docId !== doc.id) return;
    if (d.progress !== undefined) {
      progress.hidden = false;
      progressBar.style.width = `${Math.round(d.progress * 100)}%`;
      status.textContent = d.progress >= 1 ? 'Waiting for the server…' : `Uploading… ${Math.round(d.progress * 100)}%`;
    }
  };
  uploadEvents.addEventListener('upload', onEvent);

  async function send() {
    if (!validate()) {
      err.textContent ||= 'Enter a doc-ID';
      input.focus();
      return;
    }
    sendBtn.disabled = true;
    input.disabled = true;
    status.textContent = 'Preparing PDF…';
    progress.hidden = false;
    try {
      await queueUpload(doc, input.value, includeText.checked);
      progressBar.style.width = '100%';
      closeSheet();
      toast(`Uploaded to ${input.value.trim()}`);
    } catch (e) {
      const ue = e as UploadError;
      sendBtn.disabled = false;
      input.disabled = false;
      progress.hidden = true;
      if (ue.retryable) {
        closeSheet();
        toast('No connection — upload queued and will retry automatically');
      } else {
        status.textContent = '';
        err.textContent = ue.message;
      }
    }
  }

  const host = s.serverName || new URL(s.url).host;
  sheet(
    h('div', { class: 'upload-form' },
      h('div', { class: 'upload-server' }, icon('server', 18), h('span', null, h('strong', null, host), h('small', null, s.authMethod === 'password' ? `Signed in as ${s.username}` : 'Access token'))),
      h('label', { class: 'field' }, h('span', null, 'Doc-ID'), h('div', { class: 'input-with-btn' }, input, scanBtn), err),
      h('label', { class: 'row check-row' }, h('span', null, h('strong', null, 'Include recognised text'), h('small', null, 'Send OCR text along with the PDF')), includeText),
      progress, status, sendBtn,
      h('p', { class: 'secure-note' }, icon('lock', 14), 'Encrypted connection · signed request'),
    ),
    () => uploadEvents.removeEventListener('upload', onEvent),
  );
  setTimeout(() => input.focus(), 250);
}

let current: { el: HTMLElement; onClose?: () => void } | null = null;
function closeSheet() {
  if (!current) return;
  const c = current;
  current = null;
  c.el.classList.remove('open');
  c.onClose?.();
  setTimeout(() => c.el.remove(), 200);
}
function sheet(content: HTMLElement, onClose?: () => void) {
  const el = h('div', { class: 'sheet-backdrop', onClick: (e: Event) => e.target === el && closeSheet() },
    h('div', { class: 'sheet', role: 'dialog', 'aria-label': 'Upload to server' },
      h('div', { class: 'sheet-grip' }), h('h3', null, 'Upload to server'), content));
  document.body.appendChild(el);
  current = { el, onClose };
  requestAnimationFrame(() => el.classList.add('open'));
}
