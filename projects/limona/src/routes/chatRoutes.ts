import { Router } from "express";
import { z } from "zod";
import { getPool } from "../db/pool.js";
import { requireAuth } from "../auth/middleware.js";
import { isChatConnected, isAnthropicConnected } from "../config/env.js";
import { retrieveRelevantChunks, retrieveTeamKnowledgeMatch } from "../rag/retrieve.js";
import { generateAnswer } from "../rag/generateAnswer.js";
import { logError } from "../lib/logger.js";

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

const askSchema = z.object({ question: z.string().min(1).max(2000) });

chatRoutes.post("/api/chat/ask", async (req, res) => {
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
  const { question } = parsed.data;

  try {
    // Team Knowledge is checked FIRST and, if it strongly matches, answered
    // directly from the hand-written answer — no call to generateAnswer()
    // needed since there's nothing to summarize, the admin already wrote the
    // exact answer. This never touches retrieveRelevantChunks()/documents at
    // all, so existing document retrieval/citation behavior is unaffected
    // whether or not Team Knowledge has any entries.
    const teamKnowledgeMatch = await retrieveTeamKnowledgeMatch(question);
    if (teamKnowledgeMatch) {
      await getPool().query(
        "INSERT INTO chat_queries (user_id, question, answered, top_chunk_ids) VALUES ($1, $2, true, NULL)",
        [req.user!.id, question]
      );
      res.json({
        answer: teamKnowledgeMatch.answer,
        citations: [{ documentFilename: "Team Knowledge", pageOrSectionLabel: null }],
        answered: true,
      });
      return;
    }

    const retrieval = await retrieveRelevantChunks(question);

    if (!retrieval.answered) {
      await getPool().query(
        "INSERT INTO chat_queries (user_id, question, answered, top_chunk_ids) VALUES ($1, $2, false, NULL)",
        [req.user!.id, question]
      );
      res.json({
        answer: "I don't know — I couldn't find anything in the uploaded documents that answers this. Try rephrasing, or check with an admin about whether the relevant document has been uploaded.",
        citations: [],
        answered: false,
      });
      return;
    }

    const generated = await generateAnswer(question, retrieval.chunks);

    await getPool().query(
      "INSERT INTO chat_queries (user_id, question, answered, top_chunk_ids) VALUES ($1, $2, true, $3)",
      [req.user!.id, question, retrieval.chunks.map((c) => c.chunkId)]
    );

    res.json({
      answer: generated.answerText,
      citations: generated.citations,
      answered: true,
    });
  } catch (err) {
    logError("Chat ask failed", { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: "Something went wrong answering that question. Please try again." });
  }
});
