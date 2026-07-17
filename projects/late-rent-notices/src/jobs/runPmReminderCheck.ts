#!/usr/bin/env node
import { runPmReminderCheck } from "./pmReminderCheck.js";
import { runJobEntryPoint } from "./runJobEntryPoint.js";

// Assumed run time: 10:30 ET, i.e. the third of the three 10:00/10:15/10:30
// weekday cron entries — see runEscalationCheck.ts's comment on the same
// assumption; verify against the actual crontab before deploying.
void runJobEntryPoint("pm_reminder_check", 10, 30, (jobPool) => runPmReminderCheck(jobPool));
