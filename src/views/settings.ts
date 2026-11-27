import { getSettings, saveSettings, storageEstimate } from '../db';
import { languageManager } from './languages';
import { back } from '../router';
import { h, icon, iconButton } from '../ui';
import type { Settings } from '../types';
import { installPrompt } from '../pwa';
import { serverSection } from './settings-server';
import { securitySection } from './settings-security';

export async function settingsView([section]: string[] = []) {
  const s = await getSettings();
  const save = async (patch: Partial<Settings>) => {
    Object.assign(s, patch);
    // Re-read so changes made by the language manager aren't overwritten.
    await saveSettings({ ...(await getSettings()), ...patch });
  };

  const langs = languageManager();

  const select = <K extends keyof Settings>(key: K, options: [string, string][], parse: (v: string) => Settings[K] = (v) => v as Settings[K]) =>
    h(
      'select',
      { class: 'input', onChange: (e: Event) => save({ [key]: parse((e.target as HTMLSelectElement).value) } as Partial<Settings>) },
      options.map(([v, l]) => h('option', { value: v, selected: String(s[key]) === v }, l)),
    );

  const toggle = (key: 'autoOcr' | 'autoCapture', label: string, hint: string) =>
    h(
      'label',
      { class: 'row toggle' },
      h('div', null, h('strong', null, label), h('small', null, hint)),
      h('input', { type: 'checkbox', role: 'switch', checked: s[key], onChange: (e: Event) => save({ [key]: (e.target as HTMLInputElement).checked }) }),
    );

  const storage = h('small', { class: 'muted' });
  storageEstimate().then((t) => (storage.textContent = t));
  const installBtn = h('button', { class: 'btn primary', hidden: !installPrompt.available(), onClick: () => installPrompt.prompt() }, 'Install app');

  const el = h(
    'div',
    { class: 'screen settings-screen' },
    h('header', { class: 'topbar' }, iconButton('back', 'Back', () => back('/')), h('h2', null, 'Settings')),
    h(
      'main',
      { class: 'content settings' },
      h('section', null, h('h3', null, icon('camera', 16), 'Scanning'),
        toggle('autoCapture', 'Auto-capture', 'Take the photo automatically when the document is steady'),
        h('label', { class: 'row' }, h('strong', null, 'Default filter'),
          select('defaultFilter', [['enhance', 'Magic color'], ['original', 'Original'], ['gray', 'Grayscale'], ['bw', 'Black & white']])),
      ),
      h('section', null, h('h3', null, icon('languages', 16), 'Text recognition (OCR)'),
        toggle('autoOcr', 'Recognise text automatically', 'Run OCR in the background after each scan'),
        langs.el,
      ),
      h('section', null, h('h3', null, icon('pdf', 16), 'PDF export'),
        h('label', { class: 'row' }, h('strong', null, 'Page size'),
          select('pageSize', [['auto', 'Fit to scan'], ['a4', 'A4'], ['letter', 'US Letter']])),
        h('label', { class: 'row' }, h('strong', null, 'Image quality'),
          select('jpegQuality', [['0.7', 'Smaller file'], ['0.85', 'Balanced'], ['0.95', 'Best']], Number)),
      ),
      await serverSection(),
      await securitySection(),
      h('section', null, h('h3', null, icon('shield', 16), 'Privacy & app'),
        h('div', { class: 'about' },
          h('img', { src: new URL('icons/icon.svg', new URL(import.meta.env.BASE_URL, location.href)).href, alt: '' }),
          h('div', null, h('strong', null, 'DocScan OCR'), h('div', { class: 'muted' }, 'Version 1.2 · ', storage))),
        h('p', { class: 'muted', style: 'margin:0' }, 'Scans and recognised text stay on this device unless you upload them to your own server.'),
        installBtn),
    ),
  );
  if (section) requestAnimationFrame(() => el.querySelector(`#${CSS.escape(section)}`)?.scrollIntoView({ block: 'start' }));
  return { el, destroy: langs.destroy };
}
