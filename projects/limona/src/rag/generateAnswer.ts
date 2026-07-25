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
  documentCategory: string;
  content: string;
  pageOrSectionLabel: string | null;
}

// Category that means "general legal reference" (e.g. the Virginia
// Residential Landlord and Tenant Act) rather than Limehouse's own policy.
// See the "prefer company policy over general law" rule in SYSTEM_PROMPT
// below — this is the one category name that rule keys off of.
const LAW_REFERENCE_CATEGORY = "Laws";

export interface GeneratedAnswer {
  answerText: string;
  citations: Array<{ documentFilename: string; pageOrSectionLabel: string | null }>;
}

const SYSTEM_PROMPT = `You are Limona, an internal knowledge base assistant for Limehouse Property Management staff.

You will be given a staff question and a set of excerpts pulled from the company's own uploaded documents. Answer ONLY using the information in those excerpts.

Each excerpt is labeled with its source type: "Company Policy" (Limehouse's own lease, management agreements, SOPs, and other internal documents) or "General Legal Reference" (state/federal law, e.g. the Virginia Residential Landlord and Tenant Act).

Rules:
- If the excerpts do not contain enough information to answer confidently, say plainly that you don't know and do not guess. Never invent an answer.
- When BOTH a Company Policy excerpt and a General Legal Reference excerpt are relevant to the question, your answer MUST be based on and lead with the Company Policy excerpt — that is what actually governs how Limehouse operates day to day, since it was written to already comply with the law. Only mention the law as brief supporting context, never as the primary basis for the answer.
- Only fall back to a General Legal Reference excerpt as your primary answer when no Company Policy excerpt addresses the question at all.
- Always name which document(s) your answer came from, in plain language (e.g. "According to the Limehouse Lease...").
- Keep answers short and plain-language — the reader is a property management staffer, not a lawyer or developer.
- For anything with legal weight (evictions, Fair Housing, notices), remind the reader to verify against the cited source before acting, since this is a summary.`;

export async function generateAnswer(
  question: string,
  chunks: RetrievedChunk[]
): Promise<GeneratedAnswer> {
  if (!isAnthropicConnected()) throw new AnthropicNotConfiguredError();
  const env = loadEnv();

  const contextBlock = chunks
    .map((c, i) => {
      const sourceType = c.documentCategory === LAW_REFERENCE_CATEGORY ? "General Legal Reference" : "Company Policy";
      return `[Excerpt ${i + 1} — ${sourceType} — from "${c.documentFilename}"${
        c.pageOrSectionLabel ? `, ${c.pageOrSectionLabel}` : ""
      }]\n${c.content}`;
    })
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

  const citations = dedupeCitations(chunks);

  return { answerText, citations };
}

// Multiple retrieved chunks often come from the same source document (e.g.
// several sections of the same SOP), which previously made the citation list
// shown to staff repeat the same filename several times. Collapse to one
// entry per unique document, keeping the page/section label from that
// document's first (closest-matching) chunk — chunks arrive pre-sorted by
// relevance, so "first" is also "most relevant", which is a simple and
// reasonable label to show without trying to merge multiple labels together.
function dedupeCitations(
  chunks: RetrievedChunk[]
): Array<{ documentFilename: string; pageOrSectionLabel: string | null }> {
  const seen = new Set<string>();
  const citations: Array<{ documentFilename: string; pageOrSectionLabel: string | null }> = [];
  for (const c of chunks) {
    if (seen.has(c.documentId)) continue;
    seen.add(c.documentId);
    citations.push({ documentFilename: c.documentFilename, pageOrSectionLabel: c.pageOrSectionLabel });
  }
  return citations;
}
