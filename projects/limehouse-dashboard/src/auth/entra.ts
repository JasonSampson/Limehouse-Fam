import { jwtVerify, createRemoteJWKSet } from "jose";
import { loadEnv } from "../config/env.js";

// Same rigor as late-rent-notices/src/auth/entra.ts: verify the ID token's
// signature against Microsoft's own JWKS, and check aud/iss so this only
// ever accepts a token issued to THIS app registration by THIS specific
// Entra tenant — not "any Microsoft account." The app's own session cookie
// (src/auth/session.ts) is what carries identity after this point.
let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;

function getJwks() {
  const env = loadEnv();
  if (!jwks) {
    jwks = createRemoteJWKSet(
      new URL(`https://login.microsoftonline.com/${env.ENTRA_TENANT_ID}/discovery/v2.0/keys`)
    );
  }
  return jwks;
}

export function buildAuthorizeUrl(state: string, codeChallenge: string): string {
  const env = loadEnv();
  const params = new URLSearchParams({
    client_id: env.ENTRA_CLIENT_ID,
    response_type: "code",
    redirect_uri: env.ENTRA_REDIRECT_URI,
    response_mode: "query",
    scope: "openid profile email",
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });
  return `https://login.microsoftonline.com/${env.ENTRA_TENANT_ID}/oauth2/v2.0/authorize?${params.toString()}`;
}

export interface TokenExchangeResult {
  idToken: string;
}

export async function exchangeCodeForToken(code: string, codeVerifier: string): Promise<TokenExchangeResult> {
  const env = loadEnv();
  const body = new URLSearchParams({
    client_id: env.ENTRA_CLIENT_ID,
    client_secret: env.ENTRA_CLIENT_SECRET,
    grant_type: "authorization_code",
    code,
    redirect_uri: env.ENTRA_REDIRECT_URI,
    code_verifier: codeVerifier,
  });

  const res = await fetch(`https://login.microsoftonline.com/${env.ENTRA_TENANT_ID}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    throw new Error(`Entra token exchange failed: ${res.status} ${await res.text()}`);
  }
  const json = (await res.json()) as { id_token: string };
  return { idToken: json.id_token };
}

export interface VerifiedIdentity {
  entraObjectId: string;
  displayName: string;
  email: string;
}

// Validates signature against Microsoft's JWKS, checks aud/iss/exp, and
// restricts to this specific tenant.
export async function verifyIdToken(idToken: string): Promise<VerifiedIdentity> {
  const env = loadEnv();
  const { payload } = await jwtVerify(idToken, getJwks(), {
    issuer: `https://login.microsoftonline.com/${env.ENTRA_TENANT_ID}/v2.0`,
    audience: env.ENTRA_CLIENT_ID,
  });

  const entraObjectId = payload.oid as string | undefined;
  const email = (payload.preferred_username as string | undefined) ?? (payload.email as string | undefined);
  const displayName = (payload.name as string | undefined) ?? email ?? "Unknown";

  if (!entraObjectId || !email) {
    throw new Error("ID token missing required claims (oid/email)");
  }

  return { entraObjectId, displayName, email };
}
