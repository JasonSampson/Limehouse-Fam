import bcrypt from "bcryptjs";

const COST_FACTOR = 12;

// Never log or return the plain password or hash in any API response.
export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, COST_FACTOR);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}
