/**
 * App lock: PIN protected with PBKDF2-SHA256 (310k iterations) and stored
 * encrypted in the vault. Escalating lock-out after failed attempts,
 * automatic re-lock after the app has been in the background.
 */
import { eraseEverything, getSettings, saveSettings } from './db';
import { getSecret, setSecret } from './vault';
import { h, icon, confirmDialog } from './ui';

const PIN_KEY = 'lock.pin';
const FAIL_KEY = 'lock.failures';
const ITERATIONS = 310_000;

interface PinRecord { salt: string; hash: string; length: number; iterations: number }
interface Failures { count: number; until: number }

export const lockEvents = new EventTarget();
let locked = false;
let hiddenAt = 0;

const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function derive(pin: string, salt: Uint8Array, iterations: number): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: salt as Uint8Array<ArrayBuffer>, iterations }, key, 256);
  return b64(new Uint8Array(bits));
}

async function pinRecord(): Promise<PinRecord | null> {
  const raw = await getSecret(PIN_KEY);
  return raw ? (JSON.parse(raw) as PinRecord) : null;
}

export async function isLockEnabled(): Promise<boolean> {
  return (await getSettings()).security.lockEnabled && !!(await pinRecord());
}

async function failures(): Promise<Failures> {
  const raw = await getSecret(FAIL_KEY);
  return raw ? JSON.parse(raw) : { count: 0, until: 0 };
}

async function checkPin(pin: string): Promise<boolean> {
  const rec = await pinRecord();
  if (!rec) return true;
  const hash = await derive(pin, unb64(rec.salt), rec.iterations);
  // constant-time-ish compare
  let diff = hash.length ^ rec.hash.length;
  for (let i = 0; i < Math.min(hash.length, rec.hash.length); i++) diff |= hash.charCodeAt(i) ^ rec.hash.charCodeAt(i);
  return diff === 0;
}

export async function setPin(pin: string): Promise<void> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const rec: PinRecord = { salt: b64(salt), hash: await derive(pin, salt, ITERATIONS), length: pin.length, iterations: ITERATIONS };
  await setSecret(PIN_KEY, JSON.stringify(rec));
  await setSecret(FAIL_KEY, null);
}

export async function clearPin(): Promise<void> {
  await setSecret(PIN_KEY, null);
  await setSecret(FAIL_KEY, null);
}

/** Weak PINs that are refused when setting a new one. */
export function weakPin(pin: string): string | null {
  if (!/^\d{4,8}$/.test(pin)) return 'Use 4–8 digits';
  if (/^(\d)\1+$/.test(pin)) return 'Avoid repeating the same digit';
  if ('0123456789012345678'.includes(pin) || '9876543210987654321'.includes(pin)) return 'Avoid simple sequences';
  return null;
}

type PadMode =
  | { kind: 'unlock'; cancelable: boolean; title: string; subtitle?: string }
  | { kind: 'create' };

/** Full-screen PIN pad. Resolves with true on success, false if cancelled. */
function pinPad(mode: PadMode): Promise<boolean> {
  return new Promise((resolve) => {
    let entry = '';
    let first = '';
    let busy = false;
    let expectedLength = 0;
    const title = h('h2', null, mode.kind === 'create' ? 'Create a PIN' : mode.title);
    const sub = h('p', { class: 'lock-sub' }, mode.kind === 'create' ? 'Choose 4–8 digits to protect your documents' : (mode.subtitle ?? 'Enter your PIN to continue'));
    const dots = h('div', { class: 'pin-dots', 'aria-live': 'polite' });
    const msg = h('p', { class: 'lock-msg', role: 'alert' });
    const okBtn = h('button', { class: 'key key-ok', 'aria-label': 'OK', onClick: () => submit() }, icon('check', 26));

    pinRecord().then((r) => { expectedLength = mode.kind === 'unlock' ? (r?.length ?? 0) : 0; renderDots(); });

    function renderDots() {
      const n = Math.max(expectedLength || 4, entry.length);
      dots.replaceChildren(...Array.from({ length: n }, (_, i) => h('span', { class: `dot ${i < entry.length ? 'on' : ''}` })));
      okBtn.classList.toggle('ready', entry.length >= 4);
    }
    function shake(text: string) {
      msg.textContent = text;
      dots.classList.remove('shake');
      void dots.offsetWidth;
      dots.classList.add('shake');
      entry = '';
      renderDots();
    }

    async function submit() {
      if (busy || entry.length < 4) return;
      busy = true;
      try {
        if (mode.kind === 'create') {
          if (!first) {
            const weak = weakPin(entry);
            if (weak) return shake(weak);
            first = entry;
            entry = '';
            title.textContent = 'Confirm your PIN';
            sub.textContent = 'Enter the same PIN again';
            msg.textContent = '';
            renderDots();
            return;
          }
          if (entry !== first) {
            first = '';
            title.textContent = 'Create a PIN';
            sub.textContent = 'Choose 4–8 digits to protect your documents';
            return shake('PINs did not match — try again');
          }
          await setPin(entry);
          return done(true);
        }
        const f = await failures();
        if (f.until > Date.now()) return shake(`Too many attempts. Try again in ${Math.ceil((f.until - Date.now()) / 1000)} s`);
        msg.textContent = 'Checking…';
        if (await checkPin(entry)) {
          await setSecret(FAIL_KEY, null);
          return done(true);
        }
        const count = f.count + 1;
        const until = count >= 5 ? Date.now() + Math.min(15 * 60_000, 30_000 * 2 ** (count - 5)) : 0;
        await setSecret(FAIL_KEY, JSON.stringify({ count, until }));
        shake(until ? `Wrong PIN. Locked for ${Math.round((until - Date.now()) / 1000)} s` : `Wrong PIN · ${5 - count} attempt${5 - count === 1 ? '' : 's'} before a time-out`);
      } finally {
        busy = false;
      }
    }

    function press(d: string) {
      if (busy || entry.length >= 8) return;
      entry += d;
      msg.textContent = '';
      renderDots();
      if (mode.kind === 'unlock' && expectedLength && entry.length === expectedLength) submit();
    }
    function back() {
      entry = entry.slice(0, -1);
      renderDots();
    }

    const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) =>
      h('button', { class: 'key', onClick: () => press(d) }, d));
    const pad = h(
      'div',
      { class: 'keypad' },
      ...keys,
      h('button', { class: 'key key-fn', 'aria-label': 'Delete', onClick: back }, icon('delete', 24)),
      h('button', { class: 'key', onClick: () => press('0') }, '0'),
      okBtn,
    );
    const onKey = (e: KeyboardEvent) => {
      if (/^\d$/.test(e.key)) press(e.key);
      else if (e.key === 'Backspace') back();
      else if (e.key === 'Enter') submit();
      else if (e.key === 'Escape' && cancelable) done(false);
    };
    document.addEventListener('keydown', onKey);
    const cancelable = mode.kind === 'create' || mode.cancelable;

    const forgot = mode.kind === 'unlock' && !mode.cancelable
      ? h('button', {
          class: 'lock-link',
          onClick: async () => {
            if (!(await confirmDialog('Forgot your PIN? The only way back in is to erase ALL documents, settings and saved server credentials on this device.', 'Erase everything'))) return;
            await eraseEverything();
            location.reload();
          },
        }, 'Forgot PIN?')
      : null;

    const el = h(
      'div',
      { class: 'lock-screen', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'PIN' },
      cancelable && h('button', { class: 'icon-btn lock-close', 'aria-label': 'Cancel', onClick: () => done(false) }, icon('close')),
      h('div', { class: 'lock-head' }, h('div', { class: 'lock-icon' }, icon('lock', 28)), title, sub, dots, msg),
      pad,
      forgot,
    );
    document.body.appendChild(el);
    renderDots();

    function done(ok: boolean) {
      document.removeEventListener('keydown', onKey);
      el.classList.add('closing');
      setTimeout(() => el.remove(), 180);
      resolve(ok);
    }
  });
}

function setAppHidden(hidden: boolean) {
  const app = document.getElementById('app');
  if (!app) return;
  app.classList.toggle('locked', hidden);
  (app as HTMLElement & { inert: boolean }).inert = hidden;
}

/** Lock the app until the correct PIN is entered. */
export async function lockNow(): Promise<void> {
  if (locked || !(await isLockEnabled())) return;
  locked = true;
  setAppHidden(true);
  await pinPad({ kind: 'unlock', cancelable: false, title: 'DocScan is locked' });
  locked = false;
  setAppHidden(false);
  lockEvents.dispatchEvent(new Event('unlocked'));
}

/** Ask for the PIN before a sensitive action. Returns true when allowed. */
export async function requirePin(reason: string): Promise<boolean> {
  if (!(await isLockEnabled())) return true;
  return pinPad({ kind: 'unlock', cancelable: true, title: 'Confirm it’s you', subtitle: reason });
}

/** Create a PIN and enable the lock. */
export async function enableLock(): Promise<boolean> {
  if (!(await pinPad({ kind: 'create' }))) return false;
  const s = await getSettings();
  await saveSettings({ ...s, security: { ...s.security, lockEnabled: true } });
  return true;
}

export async function disableLock(): Promise<boolean> {
  if (!(await requirePin('Enter your PIN to turn off the app lock'))) return false;
  await clearPin();
  const s = await getSettings();
  await saveSettings({ ...s, security: { ...s.security, lockEnabled: false } });
  return true;
}

export async function changePin(): Promise<boolean> {
  if (!(await requirePin('Enter your current PIN'))) return false;
  return pinPad({ kind: 'create' });
}

export const isLocked = () => locked;

/** Lock on start-up and after time in the background. */
export async function initLock(): Promise<void> {
  document.addEventListener('visibilitychange', async () => {
    if (document.hidden) {
      hiddenAt = Date.now();
      // Hide content immediately so app-switcher thumbnails don't show documents.
      if (await isLockEnabled()) setAppHidden(true);
      return;
    }
    const mins = (await getSettings()).security.autoLockMinutes;
    if (hiddenAt && Date.now() - hiddenAt >= mins * 60_000) await lockNow();
    else if (!locked) setAppHidden(false);
  });
  await lockNow();
}
