import { pipeline, type FeatureExtractionPipeline } from "@xenova/transformers";

// Xenova/all-MiniLM-L6-v2 is a small (~80MB), widely-used sentence-embedding
// model that runs fully locally in Node via WASM — no API key, no external
// account, no per-query cost. It produces 384-dimensional embeddings — must
// match the document_chunks.embedding column dimension in migrations/0004.
// This is more than adequate for a 46-document corpus with low query volume;
// there's no need for a larger model at this scale.
const MODEL_NAME = "Xenova/all-MiniLM-L6-v2";

// The first call downloads and caches the model file (a few seconds, one
// time only — @xenova/transformers stores it locally after that). Every
// call after the first reuses the same in-memory pipeline instance.
let pipelinePromise: Promise<FeatureExtractionPipeline> | undefined;

function getPipeline(): Promise<FeatureExtractionPipeline> {
  if (!pipelinePromise) {
    pipelinePromise = pipeline("feature-extraction", MODEL_NAME) as Promise<FeatureExtractionPipeline>;
  }
  return pipelinePromise;
}

// Mean-pooling + normalization is the standard way to turn all-MiniLM-L6-v2's
// per-token output into a single fixed-length sentence vector — passing
// these options to the pipeline does both in one call.
async function embed(texts: string[]): Promise<number[][]> {
  const extractor = await getPipeline();
  const vectors: number[][] = [];
  for (const text of texts) {
    const output = await extractor(text, { pooling: "mean", normalize: true });
    vectors.push(Array.from(output.data as Float32Array));
  }
  return vectors;
}

export async function embedChunks(texts: string[]): Promise<number[][]> {
  return embed(texts);
}

export async function embedQuery(text: string): Promise<number[]> {
  const [vector] = await embed([text]);
  return vector;
}

// Postgres/pgvector expects a literal like '[0.1,0.2,...]' when passed as
// text and cast to ::vector.
export function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}
