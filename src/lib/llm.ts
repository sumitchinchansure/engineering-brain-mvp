const CHAT_URL = 'https://api.openai.com/v1/chat/completions';
const CHAT_MODEL = 'gpt-4o-mini';

const SYSTEM_PROMPT =
  'You are an engineering assistant that explains why code changes were made, ' +
  'using only the provided PR and commit context. Answer in 2-5 sentences. ' +
  'If the context does not contain enough information to answer confidently, ' +
  'respond with exactly: "Not enough context in indexed data to answer this confidently." ' +
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
