#!/usr/bin/env node
// Entry point for the daily 10:00 EST lateness-check job. Intended to be
// invoked by a cron entry / scheduled task on the server (Scotty's
// deployment job, not built here) — see README "Deployment notes".
import { runDailyLatenessCheck } from "./dailyLatenessCheck.js";
import { runJobEntryPoint } from "./runJobEntryPoint.js";

void runJobEntryPoint("daily_lateness_check", 10, 0, (jobPool) => runDailyLatenessCheck(jobPool));
