import { getPool } from "../db/pool.js";
import { embedQuery, toVectorLiteral } from "../rag/embeddings.js";

// Shared by the Team Knowledge "Add an Entry" form and Reporting's "Answer"
// action on a knowledge gap — both end up creating the same kind of row, so
// this is the one place that does it.
export async function createTeamKnowledgeEntry(
  question: string,
  answer: string,
  createdBy: string,
  createdByName: string
): Promise<string> {
  const embedding = await embedQuery(question);
  const result = await getPool().query(
    `INSERT INTO team_knowledge (question, answer, embedding, created_by, created_by_name)
     VALUES ($1, $2, $3::vector, $4, $5)
     RETURNING id`,
    [question, answer, toVectorLiteral(embedding), createdBy, createdByName]
  );
  return result.rows[0].id;
}
