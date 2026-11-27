/**
 * Encrypted secret storage (access tokens, signing secret, session token).
 *
 * Secrets are encrypted with AES-GCM-256 using a device key that is generated
 * as NON-EXTRACTABLE and kept in IndexedDB: page scripts can use it to
 * decrypt, but the raw key bytes can never be read out or exported, so a copy
 * of the app's storage files alone does not reveal the secrets.
 */
import { createStore, del, get, set, clear } from 'idb-keyval';

const store = createStore('docscan-vault', 'vault');
let keyPromise: Promise<CryptoKey> | null = null;

function deviceKey(): Promise<CryptoKey> {
  keyPromise ??= (async () => {
    const existing = await get<CryptoKey>('__device_key', store);
    if (existing) return existing;
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    await set('__device_key', key, store);
    return key;
  })();
  return keyPromise;
}

interface Sealed {
  iv: Uint8Array;
  data: ArrayBuffer;
}

export async function setSecret(name: string, value: string | null): Promise<void> {
  if (value === null || value === '') return del(name, store);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(name) },
    await deviceKey(),
    new TextEncoder().encode(value),
  );
  await set(name, { iv, data } satisfies Sealed, store);
}

export async function getSecret(name: string): Promise<string | null> {
  const s = await get<Sealed>(name, store);
  if (!s) return null;
  try {
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: s.iv as Uint8Array<ArrayBuffer>, additionalData: new TextEncoder().encode(name) },
      await deviceKey(),
      s.data,
    );
    return new TextDecoder().decode(plain);
  } catch {
    return null; // key rotated / tampered
  }
}

export async function hasSecret(name: string): Promise<boolean> {
  return (await get(name, store)) !== undefined;
}

export async function wipeVault(): Promise<void> {
  keyPromise = null;
  await clear(store);
}

/** Last 4 characters, for "saved ••••abcd" hints. */
export async function secretHint(name: string): Promise<string | null> {
  const v = await getSecret(name);
  return v ? `••••${v.slice(-4)}` : null;
}
