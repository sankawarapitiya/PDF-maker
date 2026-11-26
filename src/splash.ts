import { Capacitor } from '@capacitor/core';

const shownAt = performance.now();
const MIN_VISIBLE = 900; // let the logo animation play once

/** Hand over from the native splash to the web splash immediately (they match). */
export async function hideNativeSplash(): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  try {
    const { SplashScreen } = await import('@capacitor/splash-screen');
    await SplashScreen.hide({ fadeOutDuration: 150 });
  } catch {
    /* plugin unavailable */
  }
}

/** Fade out the web splash once the first screen has rendered. */
export function hideSplash(): void {
  const el = document.getElementById('splash');
  if (!el) return;
  const wait = Math.max(0, MIN_VISIBLE - (performance.now() - shownAt));
  setTimeout(() => {
    el.classList.add('hide');
    setTimeout(() => el.remove(), 400);
  }, wait);
}
