import express from "express";
import cookieParser from "cookie-parser";
import { loadEnv } from "./config/env.js";
import { authRoutes } from "./routes/authRoutes.js";
import { noticeRoutes } from "./routes/noticeRoutes.js";
import { exclusionRoutes } from "./routes/exclusionRoutes.js";
import { leaseRoutes } from "./routes/leaseRoutes.js";
import { contactAttemptRoutes } from "./routes/contactAttemptRoutes.js";
import { logInfo } from "./lib/appLogger.js";

const env = loadEnv();

const app = express();
app.use(express.json());
app.use(cookieParser());

app.get("/health", (_req, res) => {
  res.json({ ok: true, shadowMode: env.SHADOW_MODE });
});

app.use(authRoutes);
app.use(noticeRoutes);
app.use(exclusionRoutes);
app.use(leaseRoutes);
app.use(contactAttemptRoutes);

app.listen(env.PORT, () => {
  logInfo(`late-rent-notices server listening`, { port: env.PORT, shadowMode: env.SHADOW_MODE });
  if (env.SHADOW_MODE) {
    console.log(
      "\n=== SHADOW MODE ACTIVE ===\nDrafts will be generated normally; Send is a no-op that logs what would have happened.\nThis is the required default — flip SHADOW_MODE=false only after an explicit, separate decision.\n===\n"
    );
  } else {
    console.warn(
      "\n!!! LIVE MODE — SHADOW_MODE=false !!!\nReal notices will be emailed to real tenants. Confirm this is intentional.\n"
    );
  }
});
