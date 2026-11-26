interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
}
let deferred: BeforeInstallPromptEvent | null = null;

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferred = e as BeforeInstallPromptEvent;
});

export const installPrompt = {
  available: () => !!deferred,
  async prompt() {
    await deferred?.prompt();
    deferred = null;
  },
};
