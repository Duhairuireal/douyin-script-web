const encoder = new TextEncoder();
const decoder = new TextDecoder();

function toBase64(value: Uint8Array) {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string) {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function encryptionKey(secret: string) {
  if (secret.length < 32) throw new Error("API Key 加密服务尚未配置");
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(secret));
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function encryptSettings(settings: Record<string, unknown>, secret: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await encryptionKey(secret),
    encoder.encode(JSON.stringify(settings)),
  );
  return { encryptedPayload: toBase64(new Uint8Array(encrypted)), iv: toBase64(iv) };
}

export async function decryptSettings(encryptedPayload: string, iv: string, secret: string) {
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64(iv) },
    await encryptionKey(secret),
    fromBase64(encryptedPayload),
  );
  return JSON.parse(decoder.decode(decrypted)) as Record<string, unknown>;
}
