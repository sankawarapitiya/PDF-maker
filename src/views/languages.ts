import { getSettings, saveSettings } from '../db';
import {
  BUNDLED, LANGUAGES, cancelDownload, deleteLang, downloadLang, downloadedLangs, formatBytes,
  isDownloading, langEvents, type LangProgress,
} from '../langs';
import { confirmDialog, h, icon, toast } from '../ui';

/** Language-pack manager: download, cancel, delete and enable OCR languages. */
export function languageManager(): { el: HTMLElement; destroy: () => void } {
  let downloaded = new Map<string, number>();
  const progress = new Map<string, LangProgress>();
  let enabled: string[] = [];
  let filter = '';
  let onlyDownloaded = false;

  const rows = h('div', { class: 'lang-rows' });
  const summary = h('small', { class: 'muted' });
  const search = h('input', {
    class: 'input', type: 'search', placeholder: 'Find a language', 'aria-label': 'Find a language',
    onInput: () => { filter = search.value.trim().toLowerCase(); render(); },
  });
  const allTab = h('button', { class: 'chip on', onClick: () => setTab(false) }, 'All');
  const dlTab = h('button', { class: 'chip', onClick: () => setTab(true) }, 'Downloaded');
  const setTab = (v: boolean) => {
    onlyDownloaded = v;
    allTab.classList.toggle('on', !v);
    dlTab.classList.toggle('on', v);
    render();
  };

  async function setEnabled(code: string, on: boolean) {
    const s = await getSettings();
    let langs = s.ocrLangs.filter((l) => l !== code);
    if (on) langs.push(code);
    if (!langs.length) {
      langs = [BUNDLED];
      toast('At least one language is required');
    }
    enabled = langs;
    await saveSettings({ ...s, ocrLangs: langs });
    render();
  }

  async function startDownload(code: string) {
    try {
      await downloadLang(code);
      downloaded = await downloadedLangs();
      await setEnabled(code, true);
      toast(`${LANGUAGES[code]} ready for OCR`);
    } catch (e) {
      toast(`Download failed: ${(e as Error).message}. Check your connection.`);
    }
  }

  async function remove(code: string) {
    if (!(await confirmDialog(`Delete ${LANGUAGES[code]} language data?`))) return;
    await deleteLang(code);
    downloaded = await downloadedLangs();
    await setEnabled(code, false);
  }

  function row(code: string, name: string) {
    const isDl = downloaded.has(code);
    const p = progress.get(code);
    const busy = isDownloading(code);
    let status: (Node | string)[];
    if (code === BUNDLED) status = ['Built in · works offline'];
    else if (busy) {
      const pct = p?.total ? Math.round((p.loaded / p.total) * 100) : 0;
      const bar = h('div', { class: 'progress-bar' });
      bar.style.width = `${pct}%`;
      status = [
        `Downloading… ${p ? formatBytes(p.loaded) : ''}${p?.total ? ` of ${formatBytes(p.total)}` : ''}`,
        h('div', { class: 'progress' }, bar),
      ];
    } else if (isDl) status = [`Downloaded · ${formatBytes(downloaded.get(code)!)}`];
    else status = ['Not downloaded'];

    let action: HTMLElement | null = null;
    if (code === BUNDLED) action = null;
    else if (busy) action = h('button', { class: 'btn lang-act', onClick: () => cancelDownload(code) }, 'Cancel');
    else if (isDl)
      action = h('button', { class: 'btn lang-act done', 'aria-label': `Delete ${name}`, onClick: () => remove(code) }, icon('trash', 18));
    else
      action = h('button', { class: 'btn lang-act primary', onClick: () => startDownload(code) }, icon('download', 18), 'Get');

    return h(
      'div',
      { class: 'lang-row', 'data-code': code },
      h('input', {
        type: 'checkbox',
        'aria-label': `Use ${name} for OCR`,
        checked: enabled.includes(code),
        disabled: !isDl,
        onChange: (e: Event) => setEnabled(code, (e.target as HTMLInputElement).checked),
      }),
      h('div', { class: 'lang-name' }, h('strong', null, name), h('small', null, ...status)),
      action ?? h('span'),
    );
  }

  function render() {
    const list = Object.entries(LANGUAGES)
      .filter(([c, n]) => !filter || n.toLowerCase().includes(filter) || c.includes(filter))
      .filter(([c]) => !onlyDownloaded || downloaded.has(c) || isDownloading(c));
    rows.replaceChildren(...(list.length ? list.map(([c, n]) => row(c, n)) : [h('p', { class: 'muted' }, 'No matching languages')]));
    let bytes = 0;
    downloaded.forEach((v) => (bytes += v));
    summary.textContent =
      `${downloaded.size} downloaded${bytes ? ` (${formatBytes(bytes)})` : ''} · OCR uses: ` +
      enabled.map((c) => LANGUAGES[c] ?? c).join(', ');
  }

  const onProgress = (e: Event) => {
    const d = (e as CustomEvent<LangProgress>).detail;
    if (d.state === 'downloading') progress.set(d.code, d);
    else progress.delete(d.code);
    const el = rows.querySelector(`[data-code="${d.code}"]`);
    if (el) el.replaceWith(row(d.code, LANGUAGES[d.code] ?? d.code));
  };
  langEvents.addEventListener('progress', onProgress);

  Promise.all([downloadedLangs(), getSettings()]).then(([d, s]) => {
    downloaded = d;
    enabled = s.ocrLangs;
    render();
  });

  const el = h(
    'div',
    { class: 'lang-manager' },
    h('p', { class: 'muted' }, 'Download the languages that appear in your documents, then tick them to use for OCR. Downloaded languages work offline.'),
    search,
    h('div', { class: 'filter-tabs' }, allTab, dlTab),
    summary,
    rows,
  );
  return { el, destroy: () => langEvents.removeEventListener('progress', onProgress) };
}
