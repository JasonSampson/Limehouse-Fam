import type { MigrationBuilder } from "node-pg-migrate";

// Stores Limona's best-effort attempt at an unanswered question — generated
// from a looser document search than the strict threshold that decides
// whether to actually answer the asking staffer (see retrieve.ts's
// retrieveLoosestChunks). Never shown to the person who asked; it only
// surfaces in Reporting's Knowledge Gaps for an admin to Approve, Edit, or
// Reject into a real Team Knowledge entry. Null means either no draft was
// attempted yet or an admin rejected it.
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.addColumn("chat_queries", {
    draft_answer: { type: "text" },
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropColumn("chat_queries", "draft_answer");
}
