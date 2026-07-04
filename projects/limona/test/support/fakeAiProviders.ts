import { vi } from "vitest";

// DB integration tests must not depend on a real ANTHROPIC_API_KEY network
// call (slow, costs money, and not what these tests are verifying — they
// verify our own SQL/transaction/storage logic). installFakeAiProviders()
// stubs global.fetch for Anthropic's real API. Tests also individually
// vi.mock(embeddings.js) (see ingest.test.ts / retrieve.test.ts) to avoid
// loading the real local embedding model, reusing hashToUnitVector below so
// different chunk contents get different (but stable) vectors — which lets
// similarity-search tests distinguish "relevant" from "irrelevant" chunks
// without a real embedding model.
function hashToUnitVector(text: string, dim: number): number[] {
  let seed = 0;
  for (let i = 0; i < text.length; i++) {
    seed = (seed * 31 + text.charCodeAt(i)) >>> 0;
  }
  const vec: number[] = [];
  for (let i = 0; i < dim; i++) {
    seed = (seed * 1103515245 + 12345) >>> 0;
    vec.push((seed / 0xffffffff) * 2 - 1);
  }
  const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
  return vec.map((v) => v / (norm || 1));
}

export function installFakeAiProviders(): void {
  const realFetch = global.fetch;

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();

      if (url.includes("api.anthropic.com")) {
        const body = JSON.parse(init?.body as string);
        const userMessage: string = body.messages[0].content;
        return new Response(
          JSON.stringify({
            content: [{ type: "text", text: `Fake answer for: ${userMessage.slice(0, 60)}` }],
          }),
          { status: 200 }
        );
      }

      if (realFetch) return realFetch(input, init);
      throw new Error(`Unmocked fetch call to ${url}`);
    })
  );
}

export { hashToUnitVector };
