#!/usr/bin/env node
import { runPmReminderCheck } from "./pmReminderCheck.js";
import { runJobEntryPoint } from "./runJobEntryPoint.js";

void runJobEntryPoint("pm_reminder_check", (jobPool) => runPmReminderCheck(jobPool));
