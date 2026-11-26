export type View = { el: HTMLElement; destroy?: () => void };
type Handler = (params: string[]) => View | Promise<View>;

const routes: [RegExp, Handler][] = [];
let current: View | null = null;
let outlet: HTMLElement;
let depth = 0;

export function route(pattern: RegExp, handler: Handler) {
  routes.push([pattern, handler]);
}

export function navigate(path: string, replace = false) {
  const url = `#${path}`;
  if (replace) history.replaceState(null, '', url);
  else {
    history.pushState(null, '', url);
    depth++;
  }
  render();
}

export function back(fallback = '/') {
  if (depth > 0) history.back();
  else navigate(fallback, true);
}

let renderSeq = 0;
export async function render() {
  const path = location.hash.slice(1) || '/';
  const seq = ++renderSeq;
  for (const [re, handler] of routes) {
    const m = path.match(re);
    if (!m) continue;
    const view = await handler(m.slice(1).map(decodeURIComponent));
    if (seq !== renderSeq) {
      view.destroy?.();
      return;
    }
    current?.destroy?.();
    current = view;
    outlet.replaceChildren(view.el);
    window.scrollTo(0, 0);
    return;
  }
  navigate('/', true);
}

export function startRouter(el: HTMLElement) {
  outlet = el;
  window.addEventListener('popstate', () => {
    depth = Math.max(0, depth - 1);
    render();
  });
  render();
}
