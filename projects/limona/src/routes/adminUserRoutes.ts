import { Router } from "express";

// User management has been removed from Limona. Staff accounts are now managed
// entirely in LimeHQ. This file is kept as an empty stub to avoid breaking
// any imports that may remain in test files.
//
// The routes that lived here (/api/admin/users, /api/admin/users/invite,
// /api/admin/users/:id/disable) are no longer mounted on the app — see server.ts.
export const adminUserRoutes = Router();
