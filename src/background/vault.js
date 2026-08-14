/**
 * 本机密钥库：AES-GCM 密钥以 non-extractable 形式存 IndexedDB，
 * chrome.storage.local 只落密文；OAuth token 与外部 provider key 共用。
 */

const VAULT_DB_NAME = 'kimi-code-monitor-vault';
const VAULT_STORE = 'keys';
const VAULT_KEY_ID = 'external-accounts-aes-gcm';

function openVaultDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(VAULT_DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(VAULT_STORE)) db.createObjectStore(VAULT_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('无法打开密钥库'));
  });
}

// 读取或首次生成 AES-GCM 密钥；extractable=false，JS 无法导出原始密钥材料
async function getVaultKey() {
  const db = await openVaultDb();
  try {
    const existing = await new Promise((resolve, reject) => {
      const request = db.transaction(VAULT_STORE, 'readonly').objectStore(VAULT_STORE).get(VAULT_KEY_ID);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    if (existing) return existing;
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
      'encrypt',
      'decrypt'
    ]);
    await new Promise((resolve, reject) => {
      const request = db.transaction(VAULT_STORE, 'readwrite').objectStore(VAULT_STORE).put(key, VAULT_KEY_ID);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
    return key;
  } finally {
    db.close();
  }
}

function bytesToBase64(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)));
}

function base64ToBytes(text) {
  return Uint8Array.from(atob(text), (ch) => ch.charCodeAt(0));
}

export async function encryptSecret(plaintext) {
  const key = await getVaultKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(plaintext)
  );
  return { v: 1, iv: bytesToBase64(iv), data: bytesToBase64(data) };
}

export async function decryptSecret(record) {
  const key = await getVaultKey();
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: base64ToBytes(record.iv) },
    key,
    base64ToBytes(record.data)
  );
  return new TextDecoder().decode(plain);
}
