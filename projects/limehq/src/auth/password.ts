import bcrypt from "bcryptjs";

const COST_FACTOR = 12;

// Never log or return the plain password or hash in any API response.
export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, COST_FACTOR);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

// Single shared strength check, called from every route that SETS a
// password (staff creation, admin reset, self-service change) — not from
// login, which only checks the hash and shouldn't add friction. Kept here
// rather than duplicated per-route, per this codebase's house rule against
// copy-pasting validation/security logic.
export interface PasswordStrengthResult {
  valid: boolean;
  errors: string[];
}

export function validatePasswordStrength(password: string): PasswordStrengthResult {
  const errors: string[] = [];
  if (password.length < 12) {
    errors.push("Password must be at least 12 characters long.");
  }
  if (!/[A-Z]/.test(password)) {
    errors.push("Password must include at least one uppercase letter.");
  }
  if (!/[0-9]/.test(password)) {
    errors.push("Password must include at least one number.");
  }
  if (!/[^A-Za-z0-9]/.test(password)) {
    errors.push("Password must include at least one symbol.");
  }
  return { valid: errors.length === 0, errors };
}
