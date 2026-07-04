import { getPool } from "../db/pool.js";
import { embedQuery, toVectorLiteral } from "./embeddings.js";
import type { RetrievedChunk } from "./generateAnswer.js";

// Cosine DISTANCE (pgvector's <=> operator), so lower = more similar. 0 is
// identical, 2 is opposite. 0.5 is a reasonably conservative cutoff for
// "actually relevant" with all-MiniLM-L6-v2 — tightening this reduces false
// positives (confidently answering from a weakly-related chunk) at the cost
// of more "I don't know" responses. This is the single knob to tune later
// if staff report either problem.
const MAX_DISTANCE = 0.5;
// This is now purely a safety cap on how many chunks get sent to the LLM as
// context/citations, not the mechanism that decides relevance — the WHERE
// clause below (distance <= MAX_DISTANCE) does that job across the WHOLE
// candidate pool first. Set well above what a real question should ever
// need at this corpus's size, so a genuinely relevant chunk is never
// dropped just for ranking outside a small top-N window (see the
// threshold-before-limit bug this replaced).
const TOP_K = 20;

export interface RetrievalResult {
  chunks: RetrievedChunk[];
  answered: boolean;
}

export interface TeamKnowledgeMatch {
  id: string;
  question: string;
  answer: string;
  distance: number;
}

// Same cutoff as document chunk retrieval (MAX_DISTANCE above) — a Team
// Knowledge entry is "a strong match" under the identical bar used to decide
// a document chunk is relevant, so the two are comparable apples-to-apples.
// Only the single closest entry is returned: Team Knowledge answers are
// meant to be an exact, hand-written answer to one specific question, not a
// pool of context to combine like document chunks.
export async function retrieveTeamKnowledgeMatch(question: string): Promise<TeamKnowledgeMatch | null> {
  const queryEmbedding = await embedQuery(question);
  const vectorLiteral = toVectorLiteral(queryEmbedding);

  const result = await getPool().query(
    `
    SELECT id, question, answer, embedding <=> $1::vector AS distance
    FROM team_knowledge
    WHERE embedding <=> $1::vector <= $2
    ORDER BY embedding <=> $1::vector
    LIMIT 1
    `,
    [vectorLiteral, MAX_DISTANCE]
  );

  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  return { id: row.id, question: row.question, answer: row.answer, distance: Number(row.distance) };
}

// Embeds the staff question and finds the top matching chunks from
// currently-ready documents only (status='superseded' or 'processing' or
// 'failed' documents never surface here). If nothing clears the distance
// threshold, returns answered: false with no chunks — this is the "don't
// know" signal the chat route uses instead of ever hallucinating.
export async function retrieveRelevantChunks(question: string): Promise<RetrievalResult> {
  const queryEmbedding = await embedQuery(question);
  const vectorLiteral = toVectorLiteral(queryEmbedding);

  // Filter by the distance threshold in the WHERE clause BEFORE limiting to
  // TOP_K. Doing it the other way around (LIMIT first, filter after) drops
  // relevant chunks whenever 5+ unrelated chunks happen to score marginally
  // closer on raw vector distance — the relevant-but-not-top-5 chunk never
  // gets a chance to pass the threshold check. At this corpus's scale a
  // plain sequential scan over all chunks is cheap, so there's no cost to
  // evaluating the threshold across every candidate first.
  const result = await getPool().query(
    `
    SELECT
      dc.id AS chunk_id,
      dc.document_id,
      d.filename AS document_filename,
      dc.content,
      dc.page_or_section_label,
      dc.embedding <=> $1::vector AS distance
    FROM document_chunks dc
    JOIN documents d ON d.id = dc.document_id
    WHERE d.status = 'ready'
      AND dc.embedding <=> $1::vector <= $2
    ORDER BY dc.embedding <=> $1::vector
    LIMIT $3
    `,
    [vectorLiteral, MAX_DISTANCE, TOP_K]
  );

  if (result.rows.length === 0) {
    return { chunks: [], answered: false };
  }

  const chunks: RetrievedChunk[] = result.rows.map((row) => ({
    chunkId: row.chunk_id,
    documentId: row.document_id,
    documentFilename: row.document_filename,
    content: row.content,
    pageOrSectionLabel: row.page_or_section_label,
  }));

  return { chunks, answered: true };
}
