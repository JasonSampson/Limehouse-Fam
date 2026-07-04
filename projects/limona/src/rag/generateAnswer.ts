import { loadEnv, isAnthropicConnected } from "../config/env.js";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
// Small, fast, cheap model — this is a straightforward "answer from the
// provided context, cite it, and say so if you can't" task, not something
// that needs the largest model available.
const MODEL = "claude-haiku-4-5";

export class AnthropicNotConfiguredError extends Error {
  constructor() {
    super("ANTHROPIC_API_KEY is not set — Limona cannot generate answers until Jason adds it to .env.");
    this.name = "AnthropicNotConfiguredError";
  }
}

export interface RetrievedChunk {
  chunkId: string;
  documentId: string;
  documentFilename: string;
  content: string;
  pageOrSectionLabel: string | null;
}

export interface GeneratedAnswer {
  answerText: string;
  citations: Array<{ documentFilename: string; pageOrSectionLabel: string | null }>;
}

const SYSTEM_PROMPT = `You are Limona, an internal knowledge base assistant for Limehouse Property Management staff.

You will be given a staff question and a set of excerpts pulled from the company's own uploaded documents. Answer ONLY using the information in those excerpts.

Rules:
- If the excerpts do not contain enough information to answer confidently, say plainly that you don't know and do not guess. Never invent an answer.
- Always name which document(s) your answer came from, in plain language (e.g. "According to the Late Rent SOP...").
- Keep answers short and plain-language — the reader is a property management staffer, not a lawyer or developer.
- For anything with legal weight (evictions, Fair Housing, notices), remind the reader to verify against the cited source before acting, since this is a summary.`;

export async function generateAnswer(
  question: string,
  chunks: RetrievedChunk[]
): Promise<GeneratedAnswer> {
  if (!isAnthropicConnected()) throw new AnthropicNotConfiguredError();
  const env = loadEnv();

  const contextBlock = chunks
    .map(
      (c, i) =>
        `[Excerpt ${i + 1} — from "${c.documentFilename}"${
          c.pageOrSectionLabel ? `, ${c.pageOrSectionLabel}` : ""
        }]\n${c.content}`
    )
    .join("\n\n");

  const userMessage = `Question: ${question}\n\nExcerpts:\n\n${contextBlock}`;

  const response = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY as string,
      "anthropic-version": ANTHROPIC_VERSION,
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userMessage }],
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Claude API request failed (${response.status}): ${body}`);
  }

  const json = (await response.json()) as { content: Array<{ type: string; text?: string }> };
  const answerText = json.content.find((block) => block.type === "text")?.text ?? "";

  const citations = chunks.map((c) => ({
    documentFilename: c.documentFilename,
    pageOrSectionLabel: c.pageOrSectionLabel,
  }));

  return { answerText, citations };
}
