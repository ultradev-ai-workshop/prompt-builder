/**
 * Optional AI features (Refine + Test) backed by the Claude API.
 * The API key is read from .env on the server and never sent to the browser.
 * The SDK is loaded lazily so the core app runs without it.
 */
const MODEL = process.env.AI_MODEL || 'claude-opus-5-5';
const EFFORT = process.env.AI_EFFORT || 'medium';

// Server-side fallback: if a request is declined by a safety classifier,
// the API retries it on a recommended fallback model within the same call.
const FALLBACK = { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' };

const REFINE_SYSTEM = `You are an expert prompt engineer. You will receive a prompt that a user assembled with a structured prompt builder. Your job is to improve it so that a large language model produces the best possible result.

When improving the prompt:
- Keep every fact, requirement and constraint the user provided. Never invent new facts, requirements or technologies.
- Make the task unambiguous and specific; tighten wording; remove redundancy and contradictions.
- Keep the same overall structure and formatting style (Markdown headings, XML tags or plain text) as the input.
- Do not answer the prompt yourself.

Then identify the most important information the prompt is missing: questions whose answers would most improve the result (at most 5, most important first; an empty list if nothing important is missing). Finally, summarise your main changes in a few short bullet points.`;

const REFINE_SCHEMA = {
  type: 'object',
  properties: {
    improved_prompt: { type: 'string', description: 'The full improved prompt.' },
    changes: { type: 'array', items: { type: 'string' }, description: 'Short summary of the main changes.' },
    questions: { type: 'array', items: { type: 'string' }, description: 'Questions about missing information.' }
  },
  required: ['improved_prompt', 'changes', 'questions'],
  additionalProperties: false
};

let client = null;

function isConfigured() {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

function getClient() {
  if (!isConfigured()) throw httpError(503, 'AI is not configured. Add ANTHROPIC_API_KEY to .env and restart the server.');
  if (!client) {
    let Anthropic;
    try {
      Anthropic = require('@anthropic-ai/sdk');
    } catch {
      throw httpError(503, 'The Anthropic SDK is not installed. Run "npm install" and restart the server.');
    }
    client = new (Anthropic.default || Anthropic)({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return client;
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

/** Turn SDK errors into short, user-facing messages with a sensible HTTP status. */
function toHttpError(err) {
  if (err.status && !err.headers) return err; // already ours
  const Anthropic = require('@anthropic-ai/sdk');
  const A = Anthropic.default || Anthropic;
  if (err instanceof A.AuthenticationError) return httpError(401, 'The API key in .env was rejected. Check ANTHROPIC_API_KEY.');
  if (err instanceof A.RateLimitError) return httpError(429, 'Rate limited by the Claude API. Wait a moment and try again.');
  if (err instanceof A.BadRequestError) return httpError(400, `Claude API rejected the request: ${err.message}`);
  if (err instanceof A.APIError) return httpError(502, `Claude API error${err.status ? ` (${err.status})` : ''}: ${err.message}`);
  return httpError(500, err.message || 'Unexpected error');
}

/** Text produced after the last fallback switch (earlier text came from a model that declined). */
function finalText(content) {
  const lastFallback = content.map((b) => b.type).lastIndexOf('fallback');
  return content.slice(lastFallback + 1).filter((b) => b.type === 'text').map((b) => b.text).join('');
}

const usageOf = (msg) => ({ model: msg.model, input_tokens: msg.usage?.input_tokens, output_tokens: msg.usage?.output_tokens });

/** Improve a prompt and list the questions it leaves unanswered. */
async function refine(prompt) {
  try {
    const msg = await getClient().beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      ...FALLBACK,
      output_config: { effort: EFFORT, format: { type: 'json_schema', schema: REFINE_SCHEMA } },
      system: REFINE_SYSTEM,
      messages: [{ role: 'user', content: `<prompt_to_improve>\n${prompt}\n</prompt_to_improve>` }]
    });
    if (msg.stop_reason === 'refusal') throw httpError(422, 'Claude declined to refine this prompt.');
    if (msg.stop_reason === 'max_tokens') throw httpError(502, 'The refined prompt was cut off. Try a shorter prompt.');
    return { ...JSON.parse(finalText(msg.content)), usage: usageOf(msg) };
  } catch (err) {
    throw toHttpError(err);
  }
}

/**
 * Run a prompt and stream the answer as Server-Sent Events:
 *   {type:"text", text} | {type:"reset"} | {type:"done", usage, stop_reason} | {type:"error", message}
 */
async function test(prompt, req, res) {
  const anthropic = getClient(); // throws before headers are sent if not configured
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  const stream = anthropic.beta.messages.stream({
    model: MODEL,
    max_tokens: 64000,
    ...FALLBACK,
    output_config: { effort: EFFORT },
    messages: [{ role: 'user', content: prompt }]
  });
  // Stop generating (and billing) if the user closes the dialog.
  res.on('close', () => stream.abort());

  try {
    for await (const event of stream) {
      if (event.type === 'content_block_start' && event.content_block.type === 'fallback') send({ type: 'reset' });
      else if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') send({ type: 'text', text: event.delta.text });
    }
    const msg = await stream.finalMessage();
    send({ type: 'done', stop_reason: msg.stop_reason, usage: usageOf(msg) });
  } catch (err) {
    if (!res.writableEnded && !stream.aborted) send({ type: 'error', message: toHttpError(err).message });
  } finally {
    res.end();
  }
}

module.exports = { isConfigured, refine, test, MODEL };
