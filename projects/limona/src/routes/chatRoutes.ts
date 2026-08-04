import { Router } from "express";
import { z } from "zod";
import { getPool } from "../db/pool.js";
import { requireAuth } from "../auth/middleware.js";
import { isChatConnected, isAnthropicConnected } from "../config/env.js";
import { retrieveRelevantChunks, retrieveTeamKnowledgeMatch, retrieveLoosestChunks } from "../rag/retrieve.js";
import { generateAnswer } from "../rag/generateAnswer.js";
import { logError } from "../lib/logger.js";
import { asyncHandler } from "../lib/asyncHandler.js";

export const chatRoutes = Router();
chatRoutes.use(requireAuth);

// Lets the chat UI show a clear "not set up yet" banner instead of a
// broken-looking text box when the API keys haven't been configured.
chatRoutes.get("/api/chat/status", (_req, res) => {
  res.json({
    connected: isChatConnected(),
    anthropicConnected: isAnthropicConnected(),
  });
});

// Conversation history is per-user only — never shared across staff (see
// chat_conversations.user_id). Ordered by updated_at so the sitting you're
// actively adding to always floats to the top.
chatRoutes.get("/api/chat/conversations", asyncHandler(async (req, res) => {
  const result = await getPool().query(
    `SELECT id, title, updated_at FROM chat_conversations WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 50`,
    [req.user!.id]
  );
  res.json({ conversations: result.rows });
}));

// Replays one past conversation's transcript. Citations weren't stored
// separately (see migration 0014) — they're rebuilt here the same way
// Reporting's Most Common Questions does: look up which documents the
// cited chunks belong to, or "Team Knowledge" when top_chunk_ids is null on
// an answered row.
chatRoutes.get("/api/chat/conversations/:id", asyncHandler(async (req, res) => {
  const pool = getPool();
  const convCheck = await pool.query(`SELECT id FROM chat_conversations WHERE id = $1 AND user_id = $2`, [
    req.params.id,
    req.user!.id,
  ]);
  if (convCheck.rows.length === 0) {
    res.status(404).json({ error: "Conversation not found." });
    return;
  }

  const rows = await pool.query(
    `SELECT id, question, answer_text, answered, top_chunk_ids, created_at
     FROM chat_queries WHERE conversation_id = $1 ORDER BY created_at ASC`,
    [req.params.id]
  );

  const messages = [];
  for (const row of rows.rows) {
    let citations: { documentFilename: string; pageOrSectionLabel: string | null }[] = [];
    if (row.top_chunk_ids) {
      const docs = await pool.query(
        `SELECT DISTINCT d.filename
         FROM document_chunks dc JOIN documents d ON d.id = dc.document_id
         WHERE dc.id = ANY($1)`,
        [row.top_chunk_ids]
      );
      citations = docs.rows.map((d) => ({ documentFilename: d.filename, pageOrSectionLabel: null }));
    } else if (row.answered) {
      citations = [{ documentFilename: "Team Knowledge", pageOrSectionLabel: null }];
    }
    messages.push({
      question: row.question,
      answer: row.answer_text,
      answered: row.answered,
      citations,
      createdAt: row.created_at,
    });
  }

  res.json({ messages });
}));

const askSchema = z.object({
  question: z.string().min(1).max(2000),
  // .nullable() as well as .optional(): the frontend explicitly sends
  // conversationId: null before any conversation exists yet (see chat.js),
  // which JSON-serializes to a real null, not an absent field.
  conversationId: z.string().uuid().optional().nullable(),
});

chatRoutes.post("/api/chat/ask", asyncHandler(async (req, res) => {
  if (!isChatConnected()) {
    res.status(503).json({
      error:
        "Limona isn't fully set up yet — an administrator needs to add the ANTHROPIC_API_KEY to the server's .env file before chat can answer questions.",
    });
    return;
  }

  const parsed = askSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "A question is required." });
    return;
  }
  const { question, conversationId } = parsed.data;
  const pool = getPool();

  try {
    // Resolve which conversation this question belongs to: continue an
    // existing one (ownership-checked so a user can never post into someone
    // else's thread by guessing an id) or start a new one titled after this
    // first question.
    let convId = conversationId;
    if (convId) {
      const check = await pool.query(`SELECT id FROM chat_conversations WHERE id = $1 AND user_id = $2`, [
        convId,
        req.user!.id,
      ]);
      if (check.rows.length === 0) {
        res.status(404).json({ error: "Conversation not found." });
        return;
      }
    } else {
      const created = await pool.query(
        `INSERT INTO chat_conversations (user_id, title) VALUES ($1, $2) RETURNING id`,
        [req.user!.id, question.slice(0, 200)]
      );
      convId = created.rows[0].id;
    }

    // Team Knowledge is checked FIRST and, if it strongly matches, answered
    // directly from the hand-written answer — no call to generateAnswer()
    // needed since there's nothing to summarize, the admin already wrote the
    // exact answer. This never touches retrieveRelevantChunks()/documents at
    // all, so existing document retrieval/citation behavior is unaffected
    // whether or not Team Knowledge has any entries.
    const teamKnowledgeMatch = await retrieveTeamKnowledgeMatch(question);
    if (teamKnowledgeMatch) {
      await pool.query(
        "INSERT INTO chat_queries (user_id, question, answered, top_chunk_ids, conversation_id, answer_text) VALUES ($1, $2, true, NULL, $3, $4)",
        [req.user!.id, question, convId, teamKnowledgeMatch.answer]
      );
      await pool.query(`UPDATE chat_conversations SET updated_at = now() WHERE id = $1`, [convId]);
      res.json({
        answer: teamKnowledgeMatch.answer,
        citations: [{ documentFilename: "Team Knowledge", pageOrSectionLabel: null }],
        answered: true,
        conversationId: convId,
      });
      return;
    }

    const retrieval = await retrieveRelevantChunks(question);

    if (!retrieval.answered) {
      const dontKnowAnswer =
        "I don't know — I couldn't find anything in the uploaded documents that answers this. Try rephrasing, or check with an admin about whether the relevant document has been uploaded.";

      // Best-effort draft for admin review only — the asking staffer still
      // gets the plain "I don't know" above, unchanged. This never blocks or
      // changes that response: if drafting fails or Anthropic isn't
      // configured, draftAnswer just stays null and the gap behaves exactly
      // as it did before this feature existed.
      let draftAnswer: string | null = null;
      try {
        const looseChunks = await retrieveLoosestChunks(question);
        if (looseChunks.length > 0) {
          const draft = await generateAnswer(question, looseChunks);
          draftAnswer = draft.answerText;
        }
      } catch (err) {
        logError("Draft answer generation failed", { error: err instanceof Error ? err.message : String(err) });
      }

      await pool.query(
        "INSERT INTO chat_queries (user_id, question, answered, top_chunk_ids, conversation_id, answer_text, draft_answer) VALUES ($1, $2, false, NULL, $3, $4, $5)",
        [req.user!.id, question, convId, dontKnowAnswer, draftAnswer]
      );
      await pool.query(`UPDATE chat_conversations SET updated_at = now() WHERE id = $1`, [convId]);
      res.json({
        answer: dontKnowAnswer,
        citations: [],
        answered: false,
        conversationId: convId,
      });
      return;
    }

    const generated = await generateAnswer(question, retrieval.chunks);

    await pool.query(
      "INSERT INTO chat_queries (user_id, question, answered, top_chunk_ids, conversation_id, answer_text) VALUES ($1, $2, true, $3, $4, $5)",
      [req.user!.id, question, retrieval.chunks.map((c) => c.chunkId), convId, generated.answerText]
    );
    await pool.query(`UPDATE chat_conversations SET updated_at = now() WHERE id = $1`, [convId]);

    res.json({
      answer: generated.answerText,
      citations: generated.citations,
      answered: true,
      conversationId: convId,
    });
  } catch (err) {
    logError("Chat ask failed", { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: "Something went wrong answering that question. Please try again." });
  }
}));
