// LeadSimple write-sync integration point for contact_attempts.
//
// Jason wants a contact attempt logged via the admin_assistant UI/API to
// also show up in LeadSimple, but confirmed he does not yet know whether
// LeadSimple's API supports writing activity records like this — that's a
// separate, non-code task (Scotty/Jason to check LeadSimple's API docs and
// get API access provisioned) before any real client can be built.
//
// This is deliberately a single, isolated call site so the rest of the
// contact-attempt logging flow never has to change when a real client is
// wired up later — only this function's body needs to be replaced.
// Currently a no-op stub that logs and returns; it does NOT throw, so a
// missing/unconfirmed LeadSimple integration can never block or fail a
// contact_attempts insert (the DB write is the source of truth regardless
// of whether the LeadSimple mirror succeeds).
import { logInfo } from "../lib/appLogger.js";

export interface ContactAttemptSyncPayload {
  contactAttemptId: number;
  leaseId: number;
  contactMethod: "phone" | "email" | "text";
  outcome: "reached_tenant" | "left_voicemail_no_answer" | "promised_to_pay" | "disputed_charge";
  occurredAt: Date;
}

// Not-yet-configured stub. Swap the body for a real LeadSimple API call once
// Jason/Scotty confirm API access and the write is actually supported —
// callers do not need to change.
export async function syncToLeadSimple(payload: ContactAttemptSyncPayload): Promise<void> {
  logInfo("LeadSimple sync skipped: integration not yet configured", {
    contactAttemptId: payload.contactAttemptId,
    leaseId: payload.leaseId,
  });
}
