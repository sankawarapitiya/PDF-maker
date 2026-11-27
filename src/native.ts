import { Capacitor, registerPlugin } from '@capacitor/core';

interface SecurityPlugin {
  setSecure(opts: { enabled: boolean }): Promise<void>;
}
const Security = registerPlugin<SecurityPlugin>('Security');

export const canBlockScreenshots = () => Capacitor.getPlatform() === 'android';

/** Android: FLAG_SECURE blocks screenshots/screen recording and hides the app preview in Recents. */
export async function setScreenshotBlocking(enabled: boolean): Promise<void> {
  if (!canBlockScreenshots()) return;
  try {
    await Security.setSecure({ enabled });
  } catch {
    /* older native build */
  }
}
