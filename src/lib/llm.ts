const CHAT_URL = 'https://api.openai.com/v1/chat/completions';
const CHAT_MODEL = 'gpt-4o-mini';

const SYSTEM_PROMPT =
  'You are an engineering assistant that explains why code changes were made, ' +
  'using only the provided PR and commit context. Each context item includes a ' +
  'cosine similarity score (0-1) showing how close it is to the question — treat ' +
  'this as a weak, noisy signal, not proof of relevance. Answer in 2-5 sentences, ' +
  'but only if at least one context item directly and specifically addresses the ' +
  'question being asked. Do not generalize from an item that only covers a narrow, ' +
  'tangential detail (e.g. a single small commit) into a broader claim about the ' +
  'question (e.g. why an entire project or repo exists) — that item does not answer ' +
  'a question its content does not actually speak to, no matter how it scored. If the ' +
  'context items are only loosely/thematically related, or their similarity scores are ' +
  'all low and closely clustered with no clear standout, respond with exactly: ' +
  '"Not enough context in indexed data to answer this confidently." ' +
  'Never invent information that is not in the context.';

interface OpenAIChatResponse {
  choices: { message: { content: string } }[];
}

export async function answer(question: string, context: string): Promise<string> {
  const res = await fetch(CHAT_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: CHAT_MODEL,
      temperature: 0.2,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: `Question: ${question}\n\nContext (PRs and commits):\n${context}`,
        },
      ],
    }),
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new Error(`OpenAI chat completions API error (${res.status}): ${errBody}`);
  }

  const data = (await res.json()) as OpenAIChatResponse;
  return data.choices[0].message.content.trim();
}
