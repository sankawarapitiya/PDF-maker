import '@fontsource-variable/inter';
import './styles.css';
import { hideNativeSplash, hideSplash } from './splash';
import './pwa';
import { registerSW } from 'virtual:pwa-register';
import { route, startRouter, type View } from './router';
import { libraryView } from './views/library';
import { docView } from './views/doc';
import { pageView } from './views/page';
import { textView } from './views/text';
import { settingsView } from './views/settings';
import { scanView } from './views/scan';
import { events } from './pipeline';
import { toast } from './ui';
import { isNative } from './share';

route(/^\/$/, libraryView);
route(/^\/scan(?:\/([^/]+))?$/, ([docId]) => scanView(docId) as View);
route(/^\/doc\/([^/]+)$/, docView);
route(/^\/page\/([^/]+)\/([^/]+)$/, pageView);
route(/^\/text\/([^/]+)$/, textView);
route(/^\/settings$/, settingsView);

events.addEventListener('error', (e) => toast(String((e as CustomEvent).detail)));
navigator.storage?.persist?.();

hideNativeSplash();
startRouter(document.getElementById('app')!).then(hideSplash, hideSplash);

// Native builds bundle all assets already; the service worker is for the PWA.
if (import.meta.env.PROD && !isNative()) {
  registerSW({ immediate: true });
}
