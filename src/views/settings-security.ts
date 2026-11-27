import { eraseEverything, getSettings, saveSettings } from '../db';
import { changePin, disableLock, enableLock, requirePin } from '../lock';
import { canBlockScreenshots, setScreenshotBlocking } from '../native';
import { confirmDialog, h, icon, toast } from '../ui';
import type { SecuritySettings } from '../types';

async function saveSecurity(patch: Partial<SecuritySettings>) {
  const s = await getSettings();
  await saveSettings({ ...s, security: { ...s.security, ...patch } });
}

export async function securitySection(): Promise<HTMLElement> {
  const sec = (await getSettings()).security;

  const lockToggle = h('input', { type: 'checkbox', role: 'switch', checked: sec.lockEnabled, 'aria-label': 'App lock', onChange: async () => {
    const want = lockToggle.checked;
    const ok = want ? await enableLock() : await disableLock();
    if (!ok) lockToggle.checked = !want;
    else toast(want ? 'App lock on' : 'App lock off');
    lockOpts.hidden = !lockToggle.checked;
  } });

  const autoLock = h('select', { class: 'input', 'aria-label': 'Auto-lock', onChange: () => saveSecurity({ autoLockMinutes: Number(autoLock.value) }) },
    [['0', 'Immediately'], ['1', 'After 1 minute'], ['5', 'After 5 minutes'], ['15', 'After 15 minutes']].map(([v, l]) =>
      h('option', { value: v, selected: String(sec.autoLockMinutes) === v }, l)));

  const lockOpts = h('div', { class: 'section-body', hidden: !sec.lockEnabled },
    h('label', { class: 'row' }, h('div', null, h('strong', null, 'Lock when in background'), h('small', null, 'Ask for the PIN again after')), autoLock),
    h('button', { class: 'btn small', type: 'button', onClick: async () => { if (await changePin()) toast('PIN changed'); } }, icon('key', 16), 'Change PIN'),
  );

  const shots = h('input', { type: 'checkbox', role: 'switch', checked: sec.blockScreenshots, disabled: !canBlockScreenshots(), onChange: async () => {
    await saveSecurity({ blockScreenshots: shots.checked });
    await setScreenshotBlocking(shots.checked);
  } });

  const facts = [
    ['lock', 'Server credentials encrypted on device (AES-256-GCM, non-exportable key)'],
    ['shield', 'HTTPS only · requests signed with HMAC-SHA256 and protected against replay'],
    ['ok', 'Every upload carries a SHA-256 checksum verified by the server'],
  ];

  return h('section', { id: 'security' },
    h('h3', null, icon('lock', 16), 'Security'),
    h('label', { class: 'row toggle' }, h('div', null, h('strong', null, 'App lock'), h('small', null, 'Require a PIN to open DocScan')), lockToggle),
    lockOpts,
    h('label', { class: 'row toggle' }, h('div', null, h('strong', null, 'Block screenshots'),
      h('small', null, canBlockScreenshots() ? 'Also hides documents in the recent-apps view' : 'Available in the Android app')), shots),
    h('ul', { class: 'facts' }, facts.map(([i, t]) => h('li', null, icon(i, 16), t))),
    h('button', { class: 'btn danger-outline', type: 'button', onClick: async () => {
      if (!(await requirePin('Enter your PIN to erase all data'))) return;
      if (!(await confirmDialog('Erase ALL documents, settings, language packs and saved credentials from this device? This cannot be undone.', 'Erase everything'))) return;
      await eraseEverything();
      location.replace(location.pathname);
    } }, icon('shieldalert', 18), 'Erase all data on this device'),
  );
}
