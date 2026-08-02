import crypto from "node:crypto";
import { loadEnv } from "../config/env.js";

// Encrypts/decrypts users.totp_secret at rest (migration 0016's header
// comment). AES-256-GCM: a random 12-byte IV per call (GCM's recommended
// nonce size) plus the 16-byte auth tag are stored alongside the ciphertext
// so decryptSecret can verify integrity, not just confidentiality — a
// tampered ciphertext throws instead of silently decrypting to garbage.
//
// Stored format: `${ivHex}:${authTagHex}:${ciphertextHex}`. A single
// delimited string keeps this a plain `text` column (no new schema) and
// keeps the three parts unambiguous without a length-prefix scheme.
const ALGORITHM = "aes-256-gcm";
const IV_LENGTH_BYTES = 12;

function getKey(): Buffer {
  return Buffer.from(loadEnv().TOTP_ENCRYPTION_KEY, "hex");
}

export function encryptSecret(plaintext: string): string {
  const iv = crypto.randomBytes(IV_LENGTH_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${authTag.toString("hex")}:${ciphertext.toString("hex")}`;
}

export function decryptSecret(stored: string): string {
  const parts = stored.split(":");
  if (parts.length !== 3) {
    throw new Error("Malformed TOTP ciphertext");
  }
  const [ivHex, authTagHex, ciphertextHex] = parts as [string, string, string];
  const iv = Buffer.from(ivHex, "hex");
  const authTag = Buffer.from(authTagHex, "hex");
  const ciphertext = Buffer.from(ciphertextHex, "hex");

  const decipher = crypto.createDecipheriv(ALGORITHM, getKey(), iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString("utf8");
}
