#!/usr/bin/env node
import { runEscalationCheck } from "./escalationCheck.js";
import { runJobEntryPoint } from "./runJobEntryPoint.js";

// Assumed run time: 10:15 ET, i.e. the second of the three 10:00/10:15/10:30
// weekday cron entries (Jason confirmed that overall schedule; this file
// doesn't have independent confirmation of which crontab line maps to which
// script — verify against the actual crontab before deploying and adjust
// the (10, 15) below if the mapping is different).
void runJobEntryPoint("escalation_check", 10, 15, (jobPool) => runEscalationCheck(jobPool));
