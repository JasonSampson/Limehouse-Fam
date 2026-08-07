#!/usr/bin/env node
// Entry point for the daily 10:00 EST lateness-check job. Intended to be
// invoked by a cron entry / scheduled task on the server (Scotty's
// deployment job, not built here) — see README "Deployment notes".
import { runDailyLatenessCheck } from "./dailyLatenessCheck.js";
import { runJobEntryPoint } from "./runJobEntryPoint.js";

// --force: also invoked on demand by the web app (onDemandLatenessTrigger.ts)
// when a staff member opens the Late Rent Notices dashboard and it's been
// more than 15 minutes since the last run — see that file for why.
const force = process.argv.includes("--force");

void runJobEntryPoint("daily_lateness_check", 10, 0, (jobPool) => runDailyLatenessCheck(jobPool), { force });
