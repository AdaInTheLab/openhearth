/**
 * Mock fetch for openai.test.js. Replaces globalThis.fetch during tests so
 * we never actually hit api.x.ai. Returned function mimics the fetch API
 * (request → Response-shaped object).
 *
 * Usage:
 *   const fake = makeFakeXaiFetch({ response: 'hello' });
 *   openai.init(config, { fetch: fake });
 *
 * Modes:
 *   response — string content returned as {choices:[{message:{content}}]}
 *   status   — HTTP status to return (default 200)
 *   body     — override full response body (bypasses `response`)
 *   fail     — { status, message } to return as error
 *   delay    — ms before responding (for timeout tests)
 *   onRequest — callback invoked with parsed request body, for inspection
 */

export function makeFakeXaiFetch({
  response = 'ok',
  status = 200,
  body,
  fail,
  delay = 0,
  onRequest,
} = {}) {
  const calls = [];

  const fakeFetch = async (url, opts) => {
    if (delay > 0) await new Promise(r => setTimeout(r, delay));

    let parsedBody = null;
    try { parsedBody = JSON.parse(opts?.body || 'null'); } catch {}
    calls.push({ url, headers: opts?.headers, body: parsedBody });
    if (onRequest) onRequest(parsedBody);

    if (opts?.signal?.aborted) {
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    }

    if (fail) {
      return makeResponse(fail.status || 500, {
        error: { message: fail.message || 'forced failure' },
      });
    }

    if (body) return makeResponse(status, body);

    return makeResponse(status, {
      id: 'fake-openai-' + Date.now(),
      object: 'chat.completion',
      model: parsedBody?.model || 'grok-4',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: response },
        finish_reason: 'stop',
      }],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
      },
    });
  };

  fakeFetch.calls = calls;
  return fakeFetch;
}

function makeResponse(status, jsonBody) {
  const text = JSON.stringify(jsonBody);
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
    json: async () => jsonBody,
  };
}
