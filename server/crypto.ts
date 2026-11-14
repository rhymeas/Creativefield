import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
  scrypt as nodeScrypt,
  timingSafeEqual,
} from "node:crypto";

const SCRYPT_N = 16_384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEY_LENGTH = 64;
const SCRYPT_MAX_MEMORY = 64 * 1024 * 1024;
const SALT_BYTES = 16;
const TOKEN_BYTES = 32;
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const PASSWORD_MIN_BYTES = 12;
const PASSWORD_MAX_BYTES = 1024;

export function newId(): string {
  return randomUUID();
}

export function generateOpaqueToken(bytes = TOKEN_BYTES): string {
  if (!Number.isInteger(bytes) || bytes < 16 || bytes > 128) {
    throw new Error("Opaque tokens must contain between 16 and 128 bytes");
  }
  return randomBytes(bytes).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function hashBytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function validateNewPassword(password: string): void {
  const bytes = Buffer.byteLength(password, "utf8");
  if (bytes < PASSWORD_MIN_BYTES) {
    throw new Error(`Password must be at least ${PASSWORD_MIN_BYTES} bytes`);
  }
  if (bytes > PASSWORD_MAX_BYTES) {
    throw new Error(`Password must be at most ${PASSWORD_MAX_BYTES} bytes`);
  }
}

function scrypt(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    nodeScrypt(
      password,
      salt,
      SCRYPT_KEY_LENGTH,
      { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: SCRYPT_MAX_MEMORY },
      (error, derived) => {
        if (error) reject(error);
        else resolve(derived);
      },
    );
  });
}

export async function hashPassword(password: string): Promise<string> {
  validateNewPassword(password);
  const salt = randomBytes(SALT_BYTES);
  const derived = await scrypt(password, salt);
  return [
    "scrypt",
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString("base64url"),
    derived.toString("base64url"),
  ].join("$");
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  if (!password || Buffer.byteLength(password, "utf8") > PASSWORD_MAX_BYTES) return false;
  const parts = encoded.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (n !== SCRYPT_N || r !== SCRYPT_R || p !== SCRYPT_P) return false;

  try {
    const salt = Buffer.from(parts[4], "base64url");
    const expected = Buffer.from(parts[5], "base64url");
    if (salt.length !== SALT_BYTES || expected.length !== SCRYPT_KEY_LENGTH) return false;
    const actual = await scrypt(password, salt);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export type ProviderSecretContext = {
  workspaceId: string;
  providerId: string;
};

function providerAad(context: ProviderSecretContext): Buffer {
  if (!context.workspaceId || !context.providerId) {
    throw new Error("Provider secret context is required");
  }
  return Buffer.from(
    JSON.stringify(["comfyfield-provider-secret-v1", context.workspaceId, context.providerId]),
    "utf8",
  );
}

export function encryptProviderSecret(
  plaintext: string,
  masterKey: Buffer,
  context: ProviderSecretContext,
): string {
  if (!plaintext) throw new Error("Provider secret cannot be empty");
  if (Buffer.byteLength(plaintext, "utf8") > 8192) throw new Error("Provider secret is too large");
  if (masterKey.length !== 32) throw new Error("Master key must be 32 bytes");
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", masterKey, iv, { authTagLength: AUTH_TAG_BYTES });
  cipher.setAAD(providerAad(context));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", iv.toString("base64url"), tag.toString("base64url"), ciphertext.toString("base64url")].join(".");
}

export function decryptProviderSecret(
  encoded: string,
  masterKey: Buffer,
  context: ProviderSecretContext,
): string {
  if (masterKey.length !== 32) throw new Error("Master key must be 32 bytes");
  const parts = encoded.split(".");
  if (parts.length !== 4 || parts[0] !== "v1") throw new Error("Unsupported provider secret format");
  try {
    const iv = Buffer.from(parts[1], "base64url");
    const tag = Buffer.from(parts[2], "base64url");
    const ciphertext = Buffer.from(parts[3], "base64url");
    if (iv.length !== IV_BYTES || tag.length !== AUTH_TAG_BYTES) {
      throw new Error("Invalid provider secret");
    }
    const decipher = createDecipheriv("aes-256-gcm", masterKey, iv, { authTagLength: AUTH_TAG_BYTES });
    decipher.setAAD(providerAad(context));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    throw new Error("Provider secret cannot be decrypted with this key and context");
  }
}
