// This script is no longer needed. Limona's local users table has been dropped
// (migration 0009_drop_users.ts). Staff accounts are now managed in LimeHQ.
//
// To give someone access to Limona:
// 1. Create or update their account in LimeHQ (go to /staff)
// 2. Grant them the "limona.chat.access" permission
// They can then log in to Limona through LimeHQ's launcher.

console.log(
  "bootstrapAdmin is no longer needed. Staff accounts are managed in LimeHQ. See the comment in this file for details."
);
process.exit(0);
