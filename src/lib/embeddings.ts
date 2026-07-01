const EMBEDDINGS_URL = 'https://api.openai.com/v1/embeddings';
const EMBEDDING_MODEL = 'text-embedding-3-small';
// Roughly conservative char cap to stay within the model's token limit.
const MAX_INPUT_CHARS = 20000;

interface OpenAIEmbeddingResponse {
  data: { embedding: number[] }[];
}

export async function embed(text: string): Promise<number[]> {
  const input = text.slice(0, MAX_INPUT_CHARS) || ' ';

  const res = await fetch(EMBEDDINGS_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({ model: EMBEDDING_MODEL, input }),
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new Error(`OpenAI embeddings API error (${res.status}): ${errBody}`);
  }

  const data = (await res.json()) as OpenAIEmbeddingResponse;
  return data.data[0].embedding;
}
