import { getSettings, saveSettings } from '../db';
import { requirePin, isLockEnabled } from '../lock';
import {
  SECRET_SIGNING, SECRET_TOKEN, checkServerUrl, getSession, health, login, logout, type HealthInfo,
} from '../server';
import { pendingCount, resumeQueue } from '../uploads';
import { confirmDialog, formatDate, h, icon, toast } from '../ui';
import { secretHint, setSecret } from '../vault';
import type { ServerSettings } from '../types';

async function saveServer(patch: Partial<ServerSettings>) {
  const s = await getSettings();
  await saveSettings({ ...s, server: { ...s.server, ...patch } });
}

/** Masked secret field with show/hide + save; stores encrypted in the vault. */
function secretField(label: string, secretName: string, placeholder: string, onSaved?: () => void) {
  const input = h('input', { class: 'input', type: 'password', placeholder, autocomplete: 'off', spellcheck: false, 'aria-label': label });
  const hint = h('small', { class: 'muted' });
  const eye = h('button', { class: 'icon-btn', type: 'button', 'aria-label': `Show ${label}`, onClick: () => {
    input.type = input.type === 'password' ? 'text' : 'password';
    eye.replaceChildren(icon(input.type === 'password' ? 'eye' : 'eyeoff', 20));
  } }, icon('eye', 20));
  const refresh = async () => {
    const hv = await secretHint(secretName);
    hint.replaceChildren(...(hv ? [icon('lock', 12), ` Saved (encrypted) ${hv}`] : ['Not set']));
    remove.hidden = !hv;
  };
  const save = h('button', { class: 'btn primary small', type: 'button', onClick: async () => {
    if (!input.value.trim()) return toast(`Enter the ${label.toLowerCase()}`);
    await setSecret(secretName, input.value.trim());
    input.value = '';
    await refresh();
    toast(`${label} saved securely`);
    onSaved?.();
  } }, 'Save');
  const remove = h('button', { class: 'btn small ghost-dark', type: 'button', hidden: true, onClick: async () => {
    await setSecret(secretName, null);
    await refresh();
  } }, 'Remove');
  refresh();
  return h('div', { class: 'field' },
    h('span', null, label),
    h('div', { class: 'input-with-btn' }, input, eye),
    h('div', { class: 'field-actions' }, hint, h('div', { class: 'spacer' }), remove, save));
}

export async function serverSection(): Promise<HTMLElement> {
  const s = (await getSettings()).server;
  const body = h('div', { class: 'section-body' });
  const section = h('section', { id: 'server' },
    h('h3', null, icon('server', 16), 'Server upload'), body);

  const unlockGate = async () => {
    if (await isLockEnabled()) {
      body.replaceChildren(
        h('div', { class: 'gate' }, icon('lock', 20),
          h('span', null, 'Server settings are protected by your PIN.'),
          h('button', { class: 'btn small primary', onClick: async () => { if (await requirePin('Unlock server settings')) render(); } }, 'Unlock')),
      );
    } else render();
  };

  function render() {
    // Enable
    const enabled = h('input', { type: 'checkbox', role: 'switch', checked: s.enabled, onChange: async () => {
      s.enabled = enabled.checked;
      await saveServer({ enabled: s.enabled });
      details.hidden = !s.enabled;
      if (s.enabled) resumeQueue();
    } });

    // Address + test
    const urlErr = h('small', { class: 'field-error', role: 'alert' });
    const url = h('input', {
      class: 'input', type: 'url', inputMode: 'url', value: s.url, placeholder: 'https://docs.example.com/api',
      autocomplete: 'off', spellcheck: false, 'aria-label': 'Server address',
      onChange: async () => {
        const r = checkServerUrl(url.value);
        urlErr.textContent = r.error ?? '';
        if (r.url) {
          url.value = r.url;
          s.url = r.url;
          await saveServer({ url: r.url });
        }
      },
    });
    const testOut = h('div', { class: 'test-result', hidden: true });
    const testBtn = h('button', { class: 'btn small', type: 'button', onClick: async () => {
      url.dispatchEvent(new Event('change'));
      testBtn.disabled = true;
      testOut.hidden = false;
      testOut.className = 'test-result';
      testOut.replaceChildren(h('span', { class: 'spinner small' }), 'Connecting…');
      try {
        const info = await health(url.value);
        showHealth(info);
      } catch (e) {
        testOut.className = 'test-result err';
        testOut.replaceChildren(icon('alert', 18), (e as Error).message);
      } finally {
        testBtn.disabled = false;
      }
    } }, icon('refresh', 18), 'Test connection');

    async function showHealth(info: HealthInfo) {
      testOut.className = 'test-result ok';
      const signHint = info.signing === 'required' ? 'Signed requests required' : 'Signing not required';
      testOut.replaceChildren(icon('ok', 18), h('div', null,
        h('strong', null, `Connected to ${info.name}`),
        h('small', null, `${signHint} · Sign-in: ${info.auth.join(', ') || 'none'}${info.maxUploadMb ? ` · max ${info.maxUploadMb} MB` : ''}`)));
      await saveServer({ serverName: info.name });
      if (info.docIdPattern && info.docIdPattern !== s.docIdPattern) {
        s.docIdPattern = info.docIdPattern;
        pattern.value = info.docIdPattern;
        await saveServer({ docIdPattern: info.docIdPattern });
      }
      if (info.auth.length === 1 && info.auth[0] !== (s.authMethod === 'token' ? 'token' : 'password')) {
        setMethod(info.auth[0] === 'token' ? 'token' : 'password');
      }
    }

    // Auth method
    const tokenChip = h('button', { class: 'chip', type: 'button', onClick: () => setMethod('token') }, icon('key', 16), 'Access token');
    const pwChip = h('button', { class: 'chip', type: 'button', onClick: () => setMethod('password') }, icon('phone', 16), 'Username & password');
    const authBody = h('div', { class: 'auth-body' });
    async function setMethod(m: ServerSettings['authMethod']) {
      s.authMethod = m;
      await saveServer({ authMethod: m });
      tokenChip.classList.toggle('on', m === 'token');
      pwChip.classList.toggle('on', m === 'password');
      renderAuth();
    }
    async function renderAuth() {
      if (s.authMethod === 'token') {
        authBody.replaceChildren(secretField('Access token', SECRET_TOKEN, 'Paste the token from your administrator'));
        return;
      }
      const session = await getSession();
      if (session) {
        authBody.replaceChildren(h('div', { class: 'signed-in' }, icon('ok', 20),
          h('div', null, h('strong', null, `Signed in as ${session.user.name ?? session.user.username}`),
            h('small', null, `Session valid until ${formatDate(session.expiresAt)}`)),
          h('button', { class: 'btn small', type: 'button', onClick: async () => { await logout(); renderAuth(); toast('Signed out'); } }, icon('logout', 16), 'Sign out')));
        return;
      }
      const user = h('input', { class: 'input', value: s.username, placeholder: 'Username', autocomplete: 'username', autocapitalize: 'none', spellcheck: false, 'aria-label': 'Username' });
      const pass = h('input', { class: 'input', type: 'password', placeholder: 'Password', autocomplete: 'current-password', 'aria-label': 'Password' });
      const loginErr = h('small', { class: 'field-error', role: 'alert' });
      const btn = h('button', { class: 'btn primary', type: 'submit' }, icon('lock', 18), 'Sign in');
      const form = h('form', { class: 'login-form', onSubmit: async (e: Event) => {
        e.preventDefault();
        if (!user.value.trim() || !pass.value) return (loginErr.textContent = 'Enter username and password');
        btn.disabled = true;
        loginErr.textContent = '';
        try {
          s.username = user.value.trim();
          await saveServer({ username: s.username });
          await login(s.username, pass.value);
          pass.value = '';
          toast('Signed in');
          renderAuth();
          resumeQueue(true);
        } catch (err) {
          loginErr.textContent = (err as Error).message;
        } finally {
          btn.disabled = false;
          pass.value = '';
        }
      } }, user, pass, loginErr, btn,
      h('small', { class: 'muted' }, 'Your password is sent once over HTTPS and never stored on this device.'));
      authBody.replaceChildren(form);
    }

    // Doc-ID format
    const pattern = h('input', { class: 'input mono', value: s.docIdPattern, spellcheck: false, 'aria-label': 'Doc-ID pattern', onChange: async () => {
      try {
        new RegExp(pattern.value);
        s.docIdPattern = pattern.value;
        await saveServer({ docIdPattern: pattern.value });
        patternErr.textContent = '';
      } catch {
        patternErr.textContent = 'Not a valid regular expression';
      }
    } });
    const patternErr = h('small', { class: 'field-error' });

    const toggle = (key: 'includeText' | 'deleteAfterUpload', label: string, hint: string) => {
      const input = h('input', { type: 'checkbox', role: 'switch', checked: s[key], onChange: () => saveServer({ [key]: input.checked }) });
      return h('label', { class: 'row toggle' }, h('div', null, h('strong', null, label), h('small', null, hint)), input);
    };

    const queue = h('div', { class: 'queue-row', hidden: true });
    pendingCount().then((n) => {
      if (!n) return;
      queue.hidden = false;
      queue.replaceChildren(icon('upload', 18), h('span', null, `${n} upload${n === 1 ? '' : 's'} waiting`),
        h('button', { class: 'btn small', type: 'button', onClick: () => { resumeQueue(true); toast('Retrying uploads…'); } }, 'Retry now'));
    });

    const details = h('div', { class: 'section-body', hidden: !s.enabled },
      h('label', { class: 'field' }, h('span', null, 'Server address'), url, urlErr),
      h('div', { class: 'field-actions' }, testBtn),
      testOut,
      h('div', { class: 'field' }, h('span', null, 'Sign-in method'), h('div', { class: 'chips flush' }, tokenChip, pwChip)),
      authBody,
      h('details', { class: 'advanced' },
        h('summary', null, icon('shield', 16), 'Security & advanced'),
        secretField('Request signing secret', SECRET_SIGNING, 'Shared secret (if the server requires signing)'),
        h('label', { class: 'field' }, h('span', null, 'Doc-ID format (regular expression)'), pattern, patternErr,
          h('small', { class: 'muted' }, 'Filled in automatically from the server when you test the connection.')),
      ),
      toggle('includeText', 'Send recognised text', 'Upload the OCR text together with the PDF'),
      toggle('deleteAfterUpload', 'Remove from device after upload', 'Delete the local copy once the server confirms receipt'),
      queue,
      h('button', { class: 'btn danger-outline', type: 'button', onClick: async () => {
        if (!(await confirmDialog('Remove the saved token, signing secret and session from this device?', 'Remove'))) return;
        await logout();
        await setSecret(SECRET_TOKEN, null);
        await setSecret(SECRET_SIGNING, null);
        toast('Server credentials removed');
        render();
      } }, icon('trash', 18), 'Forget server credentials'),
    );

    body.replaceChildren(
      h('label', { class: 'row toggle' }, h('div', null, h('strong', null, 'Upload to a server'),
        h('small', null, 'Send documents to your organisation’s server with a doc-ID')), enabled),
      details,
    );
    tokenChip.classList.toggle('on', s.authMethod === 'token');
    pwChip.classList.toggle('on', s.authMethod === 'password');
    renderAuth();
  }

  await unlockGate();
  return section;
}
