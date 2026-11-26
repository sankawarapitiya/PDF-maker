import { getSettings, saveSettings, storageEstimate } from '../db';
import { languageManager } from './languages';
import { back } from '../router';
import { h, iconButton } from '../ui';
import type { Settings } from '../types';
import { installPrompt } from '../pwa';

export async function settingsView() {
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
      h('section', null, h('h3', null, 'Scanning'),
        toggle('autoCapture', 'Auto-capture', 'Take the photo automatically when the document is steady'),
        h('label', { class: 'row' }, h('strong', null, 'Default filter'),
          select('defaultFilter', [['enhance', 'Magic color'], ['original', 'Original'], ['gray', 'Grayscale'], ['bw', 'Black & white']])),
      ),
      h('section', null, h('h3', null, 'Text recognition (OCR)'),
        toggle('autoOcr', 'Recognise text automatically', 'Run OCR in the background after each scan'),
        langs.el,
      ),
      h('section', null, h('h3', null, 'PDF export'),
        h('label', { class: 'row' }, h('strong', null, 'Page size'),
          select('pageSize', [['auto', 'Fit to scan'], ['a4', 'A4'], ['letter', 'US Letter']])),
        h('label', { class: 'row' }, h('strong', null, 'Image quality'),
          select('jpegQuality', [['0.7', 'Smaller file'], ['0.85', 'Balanced'], ['0.95', 'Best']], Number)),
      ),
      h('section', null, h('h3', null, 'App'), storage, installBtn,
        h('p', { class: 'muted' }, 'All scans and text stay on this device. Nothing is uploaded.')),
    ),
  );
  return { el, destroy: langs.destroy };
}
