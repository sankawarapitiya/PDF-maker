import { detectDocument, scaleQuad, type Quad } from '../imaging';
import { getDoc, getSettings, saveDoc, savePage, saveSettings, uid, refreshDocCache } from '../db';
import { buildPage, maybeAutoOcr, prepare, type Prepared } from '../pipeline';
import { h, icon, iconButton, pickFiles, toast } from '../ui';
import { cropEditor } from './crop';
import { navigate } from '../router';
import type { Doc } from '../types';
import { getCurrentFolder } from '../state';

function newDocName(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `Scan ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}.${p(d.getMinutes())}`;
}

/** Get (or lazily create) the document new pages go into. */
async function targetDoc(docId?: string): Promise<Doc> {
  if (docId) {
    const d = await getDoc(docId);
    if (d) return d;
  }
  const now = Date.now();
  const doc: Doc = { id: uid(), name: newDocName(), kind: 'scan', folderId: getCurrentFolder(), createdAt: now, updatedAt: now, pageIds: [] };
  await saveDoc(doc);
  return doc;
}

export async function addPreparedToDoc(doc: Doc, p: Prepared, quad?: Quad): Promise<void> {
  const page = await buildPage(p, quad);
  await savePage(page);
  doc.pageIds.push(page.id);
  await refreshDocCache(doc);
  maybeAutoOcr(page.id, doc.id);
}

/** Import images from the gallery / file system straight into a document. */
export async function importImages(docId?: string): Promise<string | undefined> {
  const files = await pickFiles('image/*', true);
  if (!files.length) return;
  const doc = await targetDoc(docId);
  let n = 0;
  for (const f of files) {
    toast(`Processing ${++n} of ${files.length}…`, 20000);
    try {
      await addPreparedToDoc(doc, await prepare(f));
    } catch (e) {
      console.error(e);
      toast(`Could not read ${f.name}`);
    }
  }
  toast(`Added ${n} page${n === 1 ? '' : 's'}`);
  return doc.id;
}

/** Map an image-space quad onto an object-fit:contain element. */
function contentRect(vw: number, vh: number, el: HTMLElement) {
  const r = el.getBoundingClientRect();
  const s = Math.min(r.width / vw, r.height / vh);
  return { s, ox: (r.width - vw * s) / 2, oy: (r.height - vh * s) / 2, w: r.width, h: r.height };
}

export function scanView(docId?: string): { el: HTMLElement; destroy: () => void } {
  let stream: MediaStream | null = null;
  let timer = 0;
  let busy = false;
  let doc: Doc | null = null;
  let pagesAdded = 0;
  let lastQuads: Quad[] = [];
  let autoCapture = false;
  let torch = false;
  let destroyed = false;

  const video = h('video', { class: 'cam-video', playsinline: true, muted: true, autoplay: true });
  video.muted = true;
  const overlay = h('canvas', { class: 'cam-overlay' });
  const hint = h('div', { class: 'cam-hint' }, 'Looking for a document…');
  const viewport = h('div', { class: 'cam-viewport' }, video, overlay, hint);
  const counter = h('span', { class: 'badge', hidden: true }, '0');
  const doneBtn = h(
    'button',
    { class: 'cam-done', 'aria-label': 'Done', onClick: () => finish() },
    icon('check', 26),
    counter,
  );
  const autoBtn = iconButton('auto', 'Toggle auto-capture', () => {
    autoCapture = !autoCapture;
    autoBtn.classList.toggle('on', autoCapture);
    getSettings().then((s) => saveSettings({ ...s, autoCapture }));
    toast(autoCapture ? 'Auto-capture on' : 'Auto-capture off', 1200);
  });
  const torchBtn = iconButton('flash', 'Toggle flash', async () => {
    const track = stream?.getVideoTracks()[0];
    torch = !torch;
    try {
      await track?.applyConstraints({ advanced: [{ torch } as MediaTrackConstraintSet] });
      torchBtn.classList.toggle('on', torch);
    } catch {
      toast('Flash not supported');
    }
  });
  torchBtn.hidden = true;
  const shutter = h('button', { class: 'shutter', 'aria-label': 'Capture', onClick: () => capture() });

  const camScreen = h(
    'div',
    { class: 'screen camera-screen' },
    h(
      'header',
      { class: 'topbar dark floating' },
      iconButton('close', 'Close', () => finish()),
      h('div', { class: 'spacer' }),
      torchBtn,
      autoBtn,
    ),
    viewport,
    h(
      'div',
      { class: 'cam-controls' },
      iconButton('image', 'Import from gallery', () => importFromGallery(), 'round'),
      shutter,
      doneBtn,
    ),
  );
  const root = h('div', { class: 'scan-root' }, camScreen);

  getSettings().then((s) => {
    autoCapture = s.autoCapture;
    autoBtn.classList.toggle('on', autoCapture);
  });

  async function start() {
    if (!navigator.mediaDevices?.getUserMedia) return noCamera('Camera not available in this browser.');
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 3840 }, height: { ideal: 2160 } },
      });
      if (destroyed) return stopStream();
      video.srcObject = stream;
      await video.play().catch(() => undefined);
      const caps = stream.getVideoTracks()[0]?.getCapabilities?.() as { torch?: boolean } | undefined;
      torchBtn.hidden = !caps?.torch;
      timer = window.setInterval(detectLoop, 220);
    } catch (e) {
      console.warn(e);
      noCamera('Camera permission was denied or no camera was found.');
    }
  }

  function noCamera(msg: string) {
    hint.replaceChildren(
      h('p', null, msg),
      h('button', { class: 'btn primary', onClick: () => nativeCapture() }, icon('camera', 20), 'Take photo'),
      h('button', { class: 'btn', onClick: () => importFromGallery() }, icon('image', 20), 'Choose images'),
    );
    hint.classList.add('panel');
  }

  function stopStream() {
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
  }

  const small = document.createElement('canvas');
  function detectLoop() {
    if (busy || !video.videoWidth) return;
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    const s = Math.min(1, 240 / Math.max(vw, vh));
    small.width = Math.round(vw * s);
    small.height = Math.round(vh * s);
    const g = small.getContext('2d', { willReadFrequently: true })!;
    g.drawImage(video, 0, 0, small.width, small.height);
    const id = g.getImageData(0, 0, small.width, small.height);
    const q = detectDocument({ data: id.data, width: id.width, height: id.height });
    const full = q ? scaleQuad(q, vw / small.width, vh / small.height) : null;
    drawOverlay(full, vw, vh);
    if (!full) {
      lastQuads = [];
      hint.textContent = 'Place the document on a darker surface';
      hint.hidden = false;
      return;
    }
    hint.hidden = true;
    lastQuads.push(full);
    if (lastQuads.length > 6) lastQuads.shift();
    if (autoCapture && lastQuads.length === 6 && isStable(lastQuads, Math.max(vw, vh) * 0.02)) {
      lastQuads = [];
      capture();
    }
  }

  function isStable(qs: Quad[], tol: number) {
    const a = qs[0];
    return qs.every((q) => q.every((p, i) => Math.hypot(p.x - a[i].x, p.y - a[i].y) < tol));
  }

  function drawOverlay(q: Quad | null, vw: number, vh: number) {
    const { s, ox, oy, w, h: hh } = contentRect(vw, vh, viewport);
    const dpr = devicePixelRatio || 1;
    overlay.width = w * dpr;
    overlay.height = hh * dpr;
    const g = overlay.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, hh);
    if (!q) return;
    g.beginPath();
    q.forEach((p, i) => (i ? g.lineTo(ox + p.x * s, oy + p.y * s) : g.moveTo(ox + p.x * s, oy + p.y * s)));
    g.closePath();
    const ready = autoCapture && lastQuads.length >= 4;
    g.fillStyle = ready ? 'rgba(245,165,36,0.16)' : 'rgba(94,234,212,0.14)';
    g.fill();
    g.lineWidth = 3;
    g.lineJoin = 'round';
    g.strokeStyle = ready ? '#F5A524' : '#5EEAD4';
    g.shadowColor = g.strokeStyle;
    g.shadowBlur = 12;
    g.stroke();
    g.shadowBlur = 0;
    // Corner dots
    g.fillStyle = '#fff';
    for (const p of q) {
      g.beginPath();
      g.arc(ox + p.x * s, oy + p.y * s, 5, 0, Math.PI * 2);
      g.fill();
    }
  }

  async function grabFrame(): Promise<Blob> {
    const track = stream?.getVideoTracks()[0];
    const IC = (window as unknown as { ImageCapture?: new (t: MediaStreamTrack) => { takePhoto(): Promise<Blob> } }).ImageCapture;
    if (track && IC) {
      try {
        return await new IC(track).takePhoto();
      } catch {
        /* fall back to the video frame */
      }
    }
    const c = document.createElement('canvas');
    c.width = video.videoWidth;
    c.height = video.videoHeight;
    c.getContext('2d')!.drawImage(video, 0, 0);
    return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('capture failed'))), 'image/jpeg', 0.95));
  }

  async function capture() {
    if (busy) return;
    if (!stream) return nativeCapture();
    busy = true;
    camScreen.classList.add('flash');
    setTimeout(() => camScreen.classList.remove('flash'), 180);
    try {
      const blob = await grabFrame();
      await review(await prepare(blob));
    } catch (e) {
      console.error(e);
      toast('Capture failed');
      busy = false;
    }
  }

  async function nativeCapture() {
    const input = h('input', { type: 'file', accept: 'image/*', capture: 'environment', style: 'display:none' });
    input.addEventListener('change', async () => {
      const f = input.files?.[0];
      input.remove();
      if (!f) return;
      busy = true;
      try {
        await review(await prepare(f));
      } catch {
        toast('Could not read image');
        busy = false;
      }
    });
    document.body.appendChild(input);
    input.click();
  }

  async function importFromGallery() {
    busy = true;
    const id = await importImages(doc?.id ?? docId);
    busy = false;
    if (id) {
      if (!doc) doc = (await getDoc(id)) ?? null;
      pagesAdded = doc?.pageIds.length ?? pagesAdded;
      updateCounter();
    }
  }

  function updateCounter() {
    counter.textContent = String(pagesAdded);
    counter.hidden = pagesAdded === 0;
  }

  /** Show the corner editor for a captured shot. */
  async function review(p: Prepared) {
    const save = async (q: Quad) => {
      if (!doc) doc = await targetDoc(docId);
      await addPreparedToDoc(doc, p, q);
      pagesAdded++;
      updateCounter();
    };
    const editor = cropEditor({
      image: p.original,
      width: p.width,
      height: p.height,
      quad: p.quad,
      autoQuad: p.detected ? p.quad : undefined,
      title: p.detected ? 'Document detected' : 'Adjust corners',
      onCancel: back,
      actions: [
        {
          label: 'Next page', icon: 'plus',
          run: async (q) => { back(); await save(q); toast('Page saved', 1000); },
        },
        {
          label: 'Done', icon: 'check', primary: true,
          run: async (q) => { editor.replaceChildren(h('div', { class: 'spinner' })); await save(q); finish(); },
        },
      ],
    });
    camScreen.hidden = true;
    root.appendChild(editor);
    function back() {
      editor.remove();
      camScreen.hidden = false;
      busy = false;
    }
  }

  function finish() {
    const id = doc?.id ?? docId;
    if (id) navigate(`/doc/${id}`, true);
    else navigate('/', true);
  }

  start();
  return {
    el: root,
    destroy() {
      destroyed = true;
      clearInterval(timer);
      stopStream();
    },
  };
}
