#!/usr/bin/env node
import { runEscalationCheck } from "./escalationCheck.js";
import { runJobEntryPoint } from "./runJobEntryPoint.js";

void runJobEntryPoint("escalation_check", (jobPool) => runEscalationCheck(jobPool));
