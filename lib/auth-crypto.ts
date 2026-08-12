const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function randomToken(byteLength = 32): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  return toBase64Url(bytes);
}

export function createAuthId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

export async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return toBase64Url(new Uint8Array(digest));
}

export async function hmacSha256(key: string, value: string): Promise<string> {
  const imported = await crypto.subtle.importKey(
    "raw",
    encoder.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", imported, encoder.encode(value));
  return toBase64Url(new Uint8Array(signature));
}

export async function encryptIdentity(base64Key: string, plaintext: string): Promise<string> {
  const keyBytes = fromBase64Url(base64Key);
  if (keyBytes.byteLength !== 32) {
    throw new Error("IDENTITY_ENCRYPTION_KEY must be a base64url-encoded 32-byte key.");
  }
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, [
    "encrypt",
  ]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    encoder.encode(plaintext),
  );
  return `v1.${toBase64Url(iv)}.${toBase64Url(new Uint8Array(ciphertext))}`;
}

export async function decryptIdentity(base64Key: string, encrypted: string): Promise<string> {
  const [version, encodedIv, encodedCiphertext] = encrypted.split(".");
  if (version !== "v1" || !encodedIv || !encodedCiphertext) {
    throw new Error("Unsupported encrypted identity format.");
  }
  const keyBytes = fromBase64Url(base64Key);
  if (keyBytes.byteLength !== 32) {
    throw new Error("IDENTITY_ENCRYPTION_KEY must be a base64url-encoded 32-byte key.");
  }
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, [
    "decrypt",
  ]);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64Url(encodedIv) },
    key,
    fromBase64Url(encodedCiphertext),
  );
  return decoder.decode(plaintext);
}

export function toBase64Url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

export function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export function timingSafeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}
