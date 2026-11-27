import { getPages, getSettings, uid } from '../db';
import { buildPdf } from '../pdf';
import { navigate } from '../router';
import {
  BRANDS, DEFAULT_OPTIONS, JOB_STATES, canPrintDirect, directPrint, discover, getAttributes, guessBrand, ippStatusMessage,
  jobStatus, presetFor, printSettings, removePrinter, savePrinter, setDefaultPrinter, systemPrint, targetOf, validHost,
} from '../printing';
import { confirmDialog, h, icon, toast } from '../ui';
import type { Doc, PrintOptions, PrinterBrand, PrinterConfig, PrintProtocol } from '../types';

const MEDIA: [PrintOptions['media'], string][] = [
  ['iso_a4_210x297mm', 'A4'], ['na_letter_8.5x11in', 'Letter'], ['iso_a3_297x420mm', 'A3'], ['na_legal_8.5x14in', 'Legal'],
];
const SIDES: [PrintOptions['sides'], string][] = [
  ['one-sided', '1-sided'], ['two-sided-long-edge', '2-sided (long edge)'], ['two-sided-short-edge', '2-sided (short edge)'],
];

function brandBadge(b: PrinterBrand): HTMLElement {
  return h('span', { class: `brand-badge ${b}` }, b === 'toshiba' ? 'TOSHIBA' : b === 'canon' ? 'Canon' : 'IPP');
}

/** Copies / colour / sides / paper controls bound to an options object. */
function optionControls(o: PrintOptions, p?: PrinterConfig): HTMLElement {
  const copies = h('output', { class: 'stepper-val' }, String(o.copies));
  const step = (d: number) => { o.copies = Math.min(99, Math.max(1, o.copies + d)); copies.textContent = String(o.copies); };
  const colorBtns = (['monochrome', 'color'] as const).map((c) => {
    const b = h('button', { type: 'button', class: `seg ${o.color === c ? 'on' : ''}`, disabled: c === 'color' && p?.colorSupported === false,
      onClick: () => { o.color = c; colorBtns.forEach((x) => x.classList.toggle('on', x === b)); } }, c === 'color' ? 'Colour' : 'Black & white');
    return b;
  });
  const sides = h('select', { class: 'input', 'aria-label': 'Sides', onChange: () => (o.sides = sides.value as PrintOptions['sides']) },
    SIDES.map(([v, l]) => h('option', { value: v, selected: o.sides === v, disabled: v !== 'one-sided' && p?.duplexSupported === false }, l)));
  const media = h('select', { class: 'input', 'aria-label': 'Paper size', onChange: () => (o.media = media.value as PrintOptions['media']) },
    MEDIA.map(([v, l]) => h('option', { value: v, selected: o.media === v }, l)));
  return h('div', { class: 'print-options' },
    h('div', { class: 'row' }, h('strong', null, 'Copies'),
      h('div', { class: 'stepper' },
        h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Fewer copies', onClick: () => step(-1) }, icon('hr', 18)), copies,
        h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'More copies', onClick: () => step(1) }, icon('plus', 18)))),
    h('div', { class: 'row' }, h('strong', null, 'Colour'), h('div', { class: 'segmented' }, ...colorBtns)),
    h('label', { class: 'row' }, h('strong', null, 'Sides'), sides),
    h('label', { class: 'row' }, h('strong', null, 'Paper'), media));
}

// ── Print sheet ─────────────────────────────────────────────────────────────

type Source = { name: string; pdf: () => Promise<Blob>; jpegPages?: () => Promise<Blob[]> };

export async function printDoc(doc: Doc): Promise<void> {
  if (doc.kind === 'word') {
    const { wordPdf } = await import('./word');
    return printSheet({ name: doc.name, pdf: () => wordPdf(doc) });
  }
  return printSheet({
    name: doc.name,
    pdf: async () => buildPdf(await getPages(doc.pageIds), { size: (await getSettings()).pageSize, title: doc.name }),
    jpegPages: async () => (await getPages(doc.pageIds)).map((p) => p.processed),
  });
}

export function printBlob(pdf: Blob, name: string): Promise<void> {
  return printSheet({ name, pdf: async () => pdf });
}

async function printSheet(src: Source): Promise<void> {
  const settings = await printSettings();
  const printers = settings.printers;
  let selected: string = settings.defaultPrinterId && printers.some((p) => p.id === settings.defaultPrinterId) && canPrintDirect()
    ? settings.defaultPrinterId : 'system';
  const opts: PrintOptions = { ...(printers.find((p) => p.id === selected)?.defaults ?? DEFAULT_OPTIONS) };
  const optsHost = h('div');
  const status = h('div', { class: 'print-status', hidden: true });
  const printBtn = h('button', { class: 'btn primary print-go', onClick: () => go() }, icon('printer', 20), 'Print');

  const choices = h('div', { class: 'printer-choices', role: 'radiogroup', 'aria-label': 'Printer' });
  function renderChoices() {
    const mk = (id: string, title: string, sub: string, badge: HTMLElement, disabled = false) =>
      h('button', { type: 'button', role: 'radio', 'aria-checked': String(selected === id), class: `printer-choice ${selected === id ? 'on' : ''}`, disabled,
        onClick: () => { selected = id; const p = printers.find((x) => x.id === id); Object.assign(opts, p?.defaults ?? opts); renderChoices(); renderOpts(); } },
        badge, h('span', null, h('strong', null, title), h('small', null, sub)), icon(selected === id ? 'ok' : 'unchecked', 20));
    choices.replaceChildren(
      mk('system', 'System print dialog',
        canPrintDirect() ? 'Mopria, Canon PRINT & Toshiba e-BRIDGE plug-ins' : 'Your device’s own print dialog (AirPrint / browser)',
        h('span', { class: 'brand-badge sys' }, icon('printer', 16))),
      ...printers.map((p) => mk(p.id, p.name, canPrintDirect() ? `${p.host} · ${p.protocol.toUpperCase()}` : 'Direct printing needs the Android app', brandBadge(p.brand), !canPrintDirect())),
    );
  }
  function renderOpts() {
    optsHost.replaceChildren(selected === 'system'
      ? h('p', { class: 'muted small-note' }, 'Choose copies, colour and two-sided printing in the print dialog that opens.')
      : optionControls(opts, printers.find((p) => p.id === selected)));
  }

  async function go() {
    printBtn.disabled = true;
    status.hidden = false;
    status.className = 'print-status';
    status.replaceChildren(h('span', { class: 'spinner small' }), 'Preparing document…');
    try {
      if (selected === 'system') {
        const r = await systemPrint(await src.pdf(), src.name, opts);
        close();
        if (r === 'shared') toast('Choose “Print” in the share sheet');
        return;
      }
      const p = printers.find((x) => x.id === selected)!;
      const pdfOk = !p.formats?.length || p.formats.includes('application/pdf') || p.protocol === 'raw';
      let payload: { blob: Blob; format: string; name: string }[];
      if (pdfOk) payload = [{ blob: await src.pdf(), format: 'application/pdf', name: src.name }];
      else if (p.formats?.includes('image/jpeg') && src.jpegPages) {
        payload = (await src.jpegPages()).map((b, i) => ({ blob: b, format: 'image/jpeg', name: `${src.name} (${i + 1})` }));
      } else throw new Error('This printer can’t print PDF directly. Use “System print dialog”.');
      status.replaceChildren(h('span', { class: 'spinner small' }), `Sending to ${p.name}…`);
      const results = await directPrint(p, payload, { ...opts });
      const job = results[results.length - 1];
      if (p.protocol === 'raw' || !job?.jobId) {
        status.className = 'print-status ok';
        status.replaceChildren(icon('ok', 18), `Sent to ${p.name}`);
        setTimeout(close, 1500);
        return;
      }
      await follow(p, job.jobId);
    } catch (e) {
      status.className = 'print-status err';
      status.replaceChildren(icon('alert', 18), (e as Error).message || 'Printing failed');
      printBtn.disabled = false;
    }
  }

  /** Poll the job until it finishes (max ~60 s). */
  async function follow(p: PrinterConfig, jobId: number) {
    for (let i = 0; i < 30; i++) {
      let state = 3;
      let reasons: string[] = [];
      try {
        ({ jobState: state, reasons } = await jobStatus(p, jobId));
      } catch {
        break;
      }
      const label = JOB_STATES[state] ?? `State ${state}`;
      const done = state >= 7;
      status.className = `print-status ${state === 9 ? 'ok' : state >= 6 ? 'err' : ''}`;
      status.replaceChildren(done ? icon(state === 9 ? 'ok' : 'alert', 18) : h('span', { class: 'spinner small' }),
        `Job ${jobId} on ${p.name}: ${label}${state === 4 && reasons.length ? ' — release it at the printer' : ''}`);
      if (done || state === 4) {
        if (state === 9) setTimeout(close, 1500);
        else printBtn.disabled = false;
        return;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    status.className = 'print-status ok';
    status.replaceChildren(icon('ok', 18), `Job ${jobId} sent to ${p.name}`);
    setTimeout(close, 1500);
  }

  const el = h('div', { class: 'sheet-backdrop', onClick: (e: Event) => e.target === el && close() },
    h('div', { class: 'sheet print-sheet', role: 'dialog', 'aria-label': 'Print' },
      h('div', { class: 'sheet-grip' }),
      h('h3', null, `Print “${src.name}”`),
      choices,
      !printers.length && h('button', { class: 'link-btn add-printer-link', onClick: () => { close(); navigate('/settings/printers'); } },
        icon('plus', 16), 'Add a Toshiba or Canon network printer'),
      optsHost, status, printBtn));
  function close() {
    el.classList.remove('open');
    setTimeout(() => el.remove(), 200);
  }
  renderChoices();
  renderOpts();
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add('open'));
}

// ── Settings → Printers ─────────────────────────────────────────────────────

export async function printersSection(): Promise<HTMLElement> {
  const list = h('div', { class: 'printer-list' });
  const section = h('section', { id: 'printers' },
    h('h3', null, icon('printer', 16), 'Printers'),
    h('p', { class: 'muted small-note' }, 'Print to Toshiba e-STUDIO and Canon imageRUNNER / i-SENSYS network printers directly, or through the system print dialog.'),
    list,
    h('div', { class: 'field-actions' },
      h('button', { class: 'btn small primary', onClick: () => editPrinter() }, icon('plus', 16), 'Add printer'),
      h('button', { class: 'btn small', disabled: !canPrintDirect(), onClick: () => findPrinters() }, icon('radar', 16), 'Find on network')),
    !canPrintDirect() && h('p', { class: 'muted small-note' }, icon('alert', 12), ' Direct network printing and discovery run in the Android app. Here, documents print through the browser/system dialog.'));

  async function render() {
    const s = await printSettings();
    list.replaceChildren(...(s.printers.length ? s.printers.map((p) =>
      h('button', { class: 'printer-row', onClick: () => editPrinter(p) },
        brandBadge(p.brand),
        h('span', null, h('strong', null, p.name, s.defaultPrinterId === p.id && h('em', { class: 'default-tag' }, 'Default')),
          h('small', null, `${p.host}:${p.port} · ${p.protocol.toUpperCase()}${p.model ? ` · ${p.model}` : ''}`)),
        icon('chevron', 18)))
      : [h('div', { class: 'printer-empty' }, icon('printer', 22), h('span', null, 'No printers yet'))]));
  }

  async function findPrinters() {
    const btn = section.querySelector<HTMLButtonElement>('.field-actions .btn:nth-child(2)')!;
    btn.disabled = true;
    btn.replaceChildren(h('span', { class: 'spinner small' }), 'Searching…');
    try {
      const found = await discover(6000);
      if (!found.length) return toast('No printers found. Check you are on the same Wi-Fi network.');
      const existing = (await printSettings()).printers;
      const fresh = found.filter((f) => !existing.some((e) => e.host === f.host && e.port === f.port));
      if (!fresh.length) return toast('All printers on the network are already added');
      for (const f of fresh) {
        const brand = guessBrand(f.model, f.name);
        await editPrinter(undefined, {
          name: f.name, brand, host: f.host, protocol: f.tls ? 'ipps' : 'ipp', port: f.port, path: f.path || presetFor(brand, f.tls ? 'ipps' : 'ipp').path,
          model: f.model, colorSupported: f.color, duplexSupported: f.duplex,
        });
        break; // one at a time; the user can search again
      }
    } catch (e) {
      toast((e as Error).message || 'Discovery failed');
    } finally {
      btn.disabled = false;
      btn.replaceChildren(icon('radar', 16), 'Find on network');
    }
  }

  async function editPrinter(existing?: PrinterConfig, seed: Partial<PrinterConfig> = {}) {
    const ok = await printerEditor(existing, seed);
    if (ok) render();
  }

  await render();
  return section;
}

/** Full-screen add / edit printer form. Resolves true when saved or deleted. */
function printerEditor(existing?: PrinterConfig, seed: Partial<PrinterConfig> = {}): Promise<boolean> {
  return new Promise(async (resolve) => {
    const s = await printSettings();
    const p: PrinterConfig = existing
      ? structuredClone(existing)
      : { id: uid(), name: '', brand: 'toshiba', host: '', protocol: 'ipp', ...presetFor('toshiba', 'ipp'), defaults: { ...DEFAULT_OPTIONS }, ...seed };
    const done = (v: boolean) => { el.remove(); resolve(v); };

    const name = h('input', { class: 'input', value: p.name, placeholder: 'e.g. 2nd floor copier', 'aria-label': 'Printer name' });
    const host = h('input', { class: 'input', value: p.host, placeholder: '192.168.1.50 or printer.office.local', 'aria-label': 'IP address or host name', inputMode: 'url', autocapitalize: 'none', spellcheck: false });
    const port = h('input', { class: 'input', value: String(p.port), inputMode: 'numeric', 'aria-label': 'Port' });
    const path = h('input', { class: 'input mono', value: p.path, 'aria-label': 'Queue path' });
    const owner = h('input', { class: 'input', value: p.jobOwner ?? '', placeholder: 'Shown on the printer panel', 'aria-label': 'Job owner' });
    const account = h('input', { class: 'input', value: p.accountId ?? '', placeholder: 'Department ID / account code (optional)', 'aria-label': 'Department ID', autocomplete: 'off' });
    const err = h('small', { class: 'field-error', role: 'alert' });
    const testOut = h('div', { class: 'test-result', hidden: true });
    const brandChips = h('div', { class: 'chips flush' });
    const protoSel = h('select', { class: 'input', 'aria-label': 'Connection', onChange: () => {
      p.protocol = protoSel.value as PrintProtocol;
      const pr = presetFor(p.brand, p.protocol);
      port.value = String(pr.port);
      path.value = pr.path;
      path.disabled = p.protocol === 'raw';
      p.certSha256 = undefined;
    } }, [['ipp', 'IPP — port 631 (local network)'], ['ipps', 'IPPS — encrypted (recommended)'], ['raw', 'Raw 9100 — PDF direct print']].map(([v, l]) =>
      h('option', { value: v, selected: p.protocol === v }, l)));
    path.disabled = p.protocol === 'raw';

    function renderBrands() {
      brandChips.replaceChildren(...(['toshiba', 'canon', 'other'] as PrinterBrand[]).map((b) =>
        h('button', { type: 'button', class: `chip ${p.brand === b ? 'on' : ''}`, onClick: () => {
          p.brand = b;
          const pr = presetFor(b, p.protocol);
          port.value = String(pr.port);
          path.value = pr.path;
          renderBrands();
          hint.textContent = `Supports ${BRANDS[b].models}`;
        } }, b === 'toshiba' ? 'Toshiba' : b === 'canon' ? 'Canon' : 'Other')));
    }
    const hint = h('small', { class: 'muted' }, `Supports ${BRANDS[p.brand].models}`);
    renderBrands();

    function read(): boolean {
      p.name = name.value.trim() || `${BRANDS[p.brand].label.split(' ')[0]} printer`;
      // Accept pasted URLs like "ipp://10.0.0.5:631/Print": keep just the host.
      let v = host.value.trim().replace(/^[a-z]+:\/\//i, '').split('/')[0];
      if (!v.startsWith('[') && (v.match(/:/g) ?? []).length === 1) v = v.split(':')[0];
      p.host = v.replace(/^\[|\]$/g, '');
      p.port = Number(port.value) || presetFor(p.brand, p.protocol).port;
      p.path = p.protocol === 'raw' ? '' : '/' + path.value.trim().replace(/^\/+/, '');
      p.jobOwner = owner.value.trim() || undefined;
      p.accountId = account.value.trim() || undefined;
      if (!validHost(p.host)) { err.textContent = 'Enter the printer’s IP address or host name'; return false; }
      if (p.port < 1 || p.port > 65535) { err.textContent = 'Invalid port'; return false; }
      err.textContent = '';
      return true;
    }

    async function test() {
      if (!read()) return;
      if (!canPrintDirect()) return toast('Connection tests run in the Android app');
      if (p.protocol === 'raw') return toast('Raw 9100 printers have no status channel — print a test page instead');
      testOut.hidden = false;
      testOut.className = 'test-result';
      testOut.replaceChildren(h('span', { class: 'spinner small' }), 'Contacting printer…');
      try {
        let info = await getAttributes(targetOf(p), true);
        if (p.protocol === 'ipps' && info.certSha256 && info.certSha256 !== p.certSha256) {
          const fp = info.certSha256.match(/.{2}/g)!.slice(0, 16).join(':').toUpperCase();
          const trust = await confirmDialog(`First secure connection to this printer. Its certificate fingerprint is:\n\n${fp}…\n\nTrust it? DocScan will refuse to print if it ever changes.`, 'Trust printer');
          if (!trust) { testOut.hidden = true; return; }
          p.certSha256 = info.certSha256;
          info = await getAttributes(targetOf(p));
        }
        if (info.statusCode >= 0x0400) throw new Error(ippStatusMessage(info.statusCode));
        const a = info.attrs;
        const first = (k: string) => a[k]?.[0];
        p.model = String(first('printer-make-and-model') ?? p.model ?? '') || undefined;
        p.formats = (a['document-format-supported'] ?? []).map(String);
        p.colorSupported = first('color-supported') === undefined ? undefined : Boolean(first('color-supported'));
        p.duplexSupported = a['sides-supported'] ? a['sides-supported'].some((x) => String(x).startsWith('two-sided')) : undefined;
        if (!name.value.trim() && first('printer-name')) name.value = String(first('printer-name'));
        if (p.model) { p.brand = guessBrand(p.model, p.name) === 'other' ? p.brand : guessBrand(p.model, p.name); renderBrands(); }
        const stateN = Number(first('printer-state'));
        const pdf = p.formats.includes('application/pdf');
        testOut.className = 'test-result ok';
        testOut.replaceChildren(icon('ok', 18), h('div', null,
          h('strong', null, p.model || 'Printer reachable'),
          h('small', null, [stateN === 3 ? 'Ready' : stateN === 4 ? 'Busy' : stateN === 5 ? 'Stopped' : 'Online',
            pdf ? 'prints PDF directly' : p.formats.includes('image/jpeg') ? 'no PDF — scans print as images' : 'no PDF — use system dialog',
            p.colorSupported === false ? 'B&W only' : 'colour', p.duplexSupported ? '2-sided' : '1-sided'].join(' · '))));
        if (p.colorSupported === false) p.defaults.color = 'monochrome';
      } catch (e) {
        testOut.className = 'test-result err';
        testOut.replaceChildren(icon('alert', 18), (e as Error).message || 'Printer not reachable');
      }
    }

    const el = h('div', { class: 'editor-screen', role: 'dialog', 'aria-label': 'Printer' },
      h('header', { class: 'topbar' },
        h('button', { class: 'icon-btn', 'aria-label': 'Close', onClick: () => done(false) }, icon('close')),
        h('h2', null, existing ? 'Edit printer' : 'Add printer'),
        h('button', { class: 'btn small primary', onClick: async () => {
          if (!read()) return;
          await savePrinter(p);
          toast('Printer saved');
          done(true);
        } }, 'Save')),
      h('main', { class: 'content settings' },
        h('section', null,
          h('h3', null, icon('printer', 16), 'Printer'),
          h('div', { class: 'field' }, h('span', null, 'Brand'), brandChips, hint),
          h('label', { class: 'field' }, h('span', null, 'Name'), name),
          h('label', { class: 'field' }, h('span', null, 'IP address or host name'), host, err),
          h('label', { class: 'field' }, h('span', null, 'Connection'), protoSel),
          h('div', { class: 'two-col' },
            h('label', { class: 'field' }, h('span', null, 'Port'), port),
            h('label', { class: 'field' }, h('span', null, 'Queue path'), path)),
          h('div', { class: 'field-actions' }, h('button', { class: 'btn small', type: 'button', onClick: test }, icon('refresh', 16), 'Test connection')),
          testOut),
        h('section', null,
          h('h3', null, icon('key', 16), 'Job accounting'),
          h('label', { class: 'field' }, h('span', null, 'Job owner name'), owner),
          h('label', { class: 'field' }, h('span', null, 'Department ID'), account,
            h('small', { class: 'muted' }, 'Sent as the IPP job account ID. Ask your administrator whether your Toshiba/Canon device uses department codes.'))),
        h('section', null,
          h('h3', null, icon('settings', 16), 'Default print settings'),
          optionControls(p.defaults, p)),
        h('section', null,
          h('ul', { class: 'facts' },
            h('li', null, icon('shield', 16), 'Plain IPP and Raw 9100 are only allowed to printers on your local network.'),
            h('li', null, icon('lock', 16), 'IPPS encrypts the document in transit and pins the printer’s certificate.')),
          existing && h('div', { class: 'field-actions' },
            s.defaultPrinterId !== p.id && h('button', { class: 'btn small', onClick: async () => { await setDefaultPrinter(p.id); toast('Default printer set'); done(true); } }, icon('ok', 16), 'Make default'),
            h('div', { class: 'spacer' }),
            h('button', { class: 'btn small danger-outline', onClick: async () => {
              if (!(await confirmDialog(`Remove “${p.name}”?`, 'Remove'))) return;
              await removePrinter(p.id);
              done(true);
            } }, icon('trash', 16), 'Remove'))),
      ));
    document.body.appendChild(el);
    (existing ? name : host).focus();
  });
}
