import { fullQuad, isConvex, type Point, type Quad } from '../imaging';
import { h, icon } from '../ui';

export interface CropOptions {
  image: Blob;
  width: number;
  height: number;
  quad: Quad;
  autoQuad?: Quad;
  title?: string;
  actions: { label: string; icon: string; primary?: boolean; run: (q: Quad) => void }[];
  onCancel: () => void;
}

/** Full-screen corner editor with draggable handles and a magnifier loupe. */
export function cropEditor(opts: CropOptions): HTMLElement {
  let quad = opts.quad.map((p) => ({ ...p })) as Quad;
  const url = URL.createObjectURL(opts.image);
  const img = h('img', { src: url, class: 'crop-img', alt: 'Captured page', draggable: false });
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.classList.add('crop-svg');
  svg.setAttribute('viewBox', `0 0 ${opts.width} ${opts.height}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  const shade = document.createElementNS(ns, 'path');
  shade.setAttribute('class', 'crop-shade');
  shade.setAttribute('fill-rule', 'evenodd');
  const poly = document.createElementNS(ns, 'polygon');
  poly.setAttribute('class', 'crop-poly');
  svg.append(shade, poly);

  const stage = h('div', { class: 'crop-stage' });
  const frame = h('div', { class: 'crop-frame' }, img, svg);
  const handles = [0, 1, 2, 3].map((i) => h('div', { class: 'crop-handle', 'data-i': i, role: 'slider', 'aria-label': `Corner ${i + 1}` }));
  const edgeHandles = [0, 1, 2, 3].map((i) => h('div', { class: 'crop-handle edge', 'data-e': i, 'aria-hidden': 'true' }));
  frame.append(...edgeHandles, ...handles);
  const loupe = h('canvas', { class: 'loupe', width: 220, height: 220 });
  stage.append(frame, loupe);

  const fit = () => {
    const r = stage.getBoundingClientRect();
    const pad = 28;
    const s = Math.min((r.width - pad * 2) / opts.width, (r.height - pad * 2) / opts.height);
    frame.style.width = `${opts.width * s}px`;
    frame.style.height = `${opts.height * s}px`;
    render();
  };
  const scale = () => frame.clientWidth / opts.width || 1;

  function render() {
    const s = scale();
    const pts = quad.map((p) => `${p.x},${p.y}`).join(' ');
    poly.setAttribute('points', pts);
    shade.setAttribute('d', `M0 0H${opts.width}V${opts.height}H0Z M${quad.map((p) => `${p.x} ${p.y}`).join(' L')}Z`);
    poly.classList.toggle('invalid', !isConvex(quad));
    handles.forEach((el, i) => {
      el.style.transform = `translate(${quad[i].x * s}px, ${quad[i].y * s}px)`;
    });
    edgeHandles.forEach((el, i) => {
      const a = quad[i];
      const b = quad[(i + 1) % 4];
      el.style.transform = `translate(${((a.x + b.x) / 2) * s}px, ${((a.y + b.y) / 2) * s}px)`;
    });
  }

  function drawLoupe(p: Point, client: { x: number; y: number }) {
    const g = loupe.getContext('2d')!;
    // Show the area under the finger magnified 2.5x relative to the screen.
    const sw = Math.max(20, loupe.width / 2.5 / scale());
    g.clearRect(0, 0, loupe.width, loupe.height);
    g.save();
    g.beginPath();
    g.arc(110, 110, 108, 0, Math.PI * 2);
    g.clip();
    g.fillStyle = '#000';
    g.fillRect(0, 0, 220, 220);
    g.drawImage(img, p.x - sw / 2, p.y - sw / 2, sw, sw, 0, 0, 220, 220);
    g.restore();
    g.strokeStyle = '#F5A524';
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(110, 90); g.lineTo(110, 130); g.moveTo(90, 110); g.lineTo(130, 110);
    g.stroke();
    const sr = stage.getBoundingClientRect();
    // Keep loupe away from the finger: top-left unless the finger is there.
    const left = client.x - sr.left < sr.width / 2 ? sr.width - 236 : 16;
    loupe.style.left = `${left}px`;
    loupe.style.top = '16px';
    loupe.style.display = 'block';
  }

  let drag: { i?: number; e?: number; start: Point; orig: Quad } | null = null;
  const toImage = (e: PointerEvent): Point => {
    const r = frame.getBoundingClientRect();
    const s = scale();
    return {
      x: Math.min(opts.width, Math.max(0, (e.clientX - r.left) / s)),
      y: Math.min(opts.height, Math.max(0, (e.clientY - r.top) / s)),
    };
  };
  frame.addEventListener('pointerdown', (e) => {
    const t = e.target as HTMLElement;
    if (!t.classList.contains('crop-handle')) return;
    e.preventDefault();
    t.setPointerCapture(e.pointerId);
    drag = {
      i: t.dataset.i !== undefined ? Number(t.dataset.i) : undefined,
      e: t.dataset.e !== undefined ? Number(t.dataset.e) : undefined,
      start: toImage(e),
      orig: quad.map((p) => ({ ...p })) as Quad,
    };
    t.classList.add('active');
  });
  frame.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const p = toImage(e);
    if (drag.i !== undefined) {
      quad[drag.i] = p;
      drawLoupe(p, { x: e.clientX, y: e.clientY });
    } else if (drag.e !== undefined) {
      const dx = p.x - drag.start.x;
      const dy = p.y - drag.start.y;
      for (const k of [drag.e, (drag.e + 1) % 4]) {
        quad[k] = {
          x: Math.min(opts.width, Math.max(0, drag.orig[k].x + dx)),
          y: Math.min(opts.height, Math.max(0, drag.orig[k].y + dy)),
        };
      }
    }
    render();
  });
  const end = () => {
    drag = null;
    loupe.style.display = 'none';
    frame.querySelectorAll('.active').forEach((x) => x.classList.remove('active'));
  };
  frame.addEventListener('pointerup', end);
  frame.addEventListener('pointercancel', end);

  const setQuad = (q: Quad) => {
    quad = q.map((p) => ({ ...p })) as Quad;
    render();
  };

  const tools = h(
    'div',
    { class: 'crop-tools' },
    opts.autoQuad &&
      h('button', { class: 'chip', onClick: () => setQuad(opts.autoQuad!) }, icon('auto', 18), 'Auto'),
    h('button', { class: 'chip', onClick: () => setQuad(fullQuad(opts.width, opts.height)) }, icon('crop', 18), 'Full page'),
  );

  const bar = h(
    'div',
    { class: 'bottom-bar' },
    h('button', { class: 'btn ghost', onClick: () => { cleanup(); opts.onCancel(); } }, 'Retake'),
    ...opts.actions.map((a) =>
      h(
        'button',
        {
          class: `btn ${a.primary ? 'primary' : ''}`,
          onClick: () => {
            if (!isConvex(quad)) {
              poly.classList.add('shake');
              setTimeout(() => poly.classList.remove('shake'), 400);
              return;
            }
            cleanup();
            a.run(quad.map((p) => ({ ...p })) as Quad);
          },
        },
        icon(a.icon, 20),
        a.label,
      ),
    ),
  );

  const root = h(
    'div',
    { class: 'screen crop-screen' },
    h('header', { class: 'topbar dark' }, h('h2', null, opts.title ?? 'Adjust corners'), tools),
    stage,
    bar,
  );
  const ro = new ResizeObserver(fit);
  ro.observe(stage);
  img.addEventListener('load', fit);
  function cleanup() {
    ro.disconnect();
    URL.revokeObjectURL(url);
  }
  return root;
}
