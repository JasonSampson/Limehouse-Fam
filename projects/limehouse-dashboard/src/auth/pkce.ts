import { randomBytes, createHash } from "node:crypto";

export interface PkcePair {
  verifier: string;
  challenge: string;
}

function base64UrlEncode(buffer: Buffer): string {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function generatePkcePair(): PkcePair {
  const verifier = base64UrlEncode(randomBytes(32));
  const challenge = base64UrlEncode(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

export function generateState(): string {
  return base64UrlEncode(randomBytes(16));
}
