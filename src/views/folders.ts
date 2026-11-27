import { FOLDER_COLORS, createFolder, descendants, listDocs, listFolders } from '../db';
import { h, icon } from '../ui';
import type { Folder } from '../types';

/** Coloured folder glyph. */
export function folderIcon(color: string, size = 28): HTMLElement {
  const el = h('span', { class: 'folder-glyph' }, icon('foldericon', size));
  el.style.color = color;
  return el;
}

/** Name + colour dialog for creating / renaming a folder. */
export function folderDialog(title: string, name = '', color = FOLDER_COLORS[0]): Promise<{ name: string; color: string } | null> {
  return new Promise((resolve) => {
    let chosen = color;
    const input = h('input', { class: 'input', value: name, placeholder: 'Folder name', 'aria-label': 'Folder name', maxLength: 60 });
    const swatches = h('div', { class: 'swatches', role: 'radiogroup', 'aria-label': 'Colour' },
      FOLDER_COLORS.map((c) => {
        const b = h('button', { type: 'button', class: `swatch ${c === chosen ? 'on' : ''}`, role: 'radio', 'aria-label': `Colour ${c}`, onClick: () => {
          chosen = c;
          swatches.querySelectorAll('.swatch').forEach((s) => s.classList.toggle('on', s === b));
          preview.style.color = c;
        } });
        b.style.background = c;
        return b;
      }));
    const preview = folderIcon(chosen, 40);
    const close = (v: { name: string; color: string } | null) => { overlay.remove(); resolve(v); };
    const form = h('form', { class: 'modal', onSubmit: (e: Event) => {
      e.preventDefault();
      const n = input.value.trim();
      if (!n) return input.focus();
      close({ name: n, color: chosen });
    } },
      h('div', { class: 'folder-dialog-head' }, preview, h('h3', null, title)),
      input, swatches,
      h('div', { class: 'modal-actions' },
        h('button', { class: 'btn', type: 'button', onClick: () => close(null) }, 'Cancel'),
        h('button', { class: 'btn primary', type: 'submit' }, 'Save')));
    const overlay = h('div', { class: 'modal-backdrop' }, form);
    document.body.appendChild(overlay);
    input.focus();
    input.select();
  });
}

/**
 * Pick a destination folder. Resolves with a folder id, null for the
 * library root ("Home"), or undefined when cancelled.
 */
export function pickFolder(title: string, opts: { exclude?: string; current?: string | null } = {}): Promise<string | null | undefined> {
  return new Promise(async (resolve) => {
    let folders = await listFolders();
    const docs = await listDocs();
    const close = (v: string | null | undefined) => {
      el.classList.remove('open');
      setTimeout(() => el.remove(), 200);
      resolve(v);
    };
    const list = h('div', { class: 'folder-tree' });
    function render() {
      const blocked = opts.exclude ? descendants(folders, opts.exclude) : new Set<string>();
      const rows: HTMLElement[] = [
        h('button', { class: `tree-row ${opts.current === null ? 'current' : ''}`, disabled: opts.current === null, onClick: () => close(null) },
          icon('folder', 22), h('span', null, 'Home (no folder)')),
      ];
      const walk = (parent: string | null, depth: number) => {
        for (const f of folders.filter((x) => x.parentId === parent)) {
          if (blocked.has(f.id)) continue;
          const n = docs.filter((d) => d.folderId === f.id).length;
          const row = h('button', { class: `tree-row ${opts.current === f.id ? 'current' : ''}`, disabled: opts.current === f.id, onClick: () => close(f.id) },
            folderIcon(f.color, 22), h('span', null, f.name), h('small', null, String(n)));
          row.style.paddingLeft = `${12 + depth * 22}px`;
          rows.push(row);
          walk(f.id, depth + 1);
        }
      };
      walk(null, 0);
      list.replaceChildren(...rows);
    }
    render();
    const el = h('div', { class: 'sheet-backdrop', onClick: (e: Event) => e.target === el && close(undefined) },
      h('div', { class: 'sheet', role: 'dialog', 'aria-label': title },
        h('div', { class: 'sheet-grip' }), h('h3', null, title), list,
        h('button', { class: 'btn', onClick: async () => {
          const r = await folderDialog('New folder');
          if (!r) return;
          const f: Folder = await createFolder(r.name, null, r.color);
          folders = await listFolders();
          close(f.id);
        } }, icon('folderplus', 20), 'New folder'),
        h('button', { class: 'btn ghost-dark sheet-cancel', onClick: () => close(undefined) }, 'Cancel')));
    document.body.appendChild(el);
    requestAnimationFrame(() => el.classList.add('open'));
  });
}
