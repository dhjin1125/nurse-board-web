import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { once } from 'node:events';
import { registerAiJobRoutes, requestOpenAiIntent } from '../lib/ai-job-routes.mjs';

async function startApp(t, options) {
  const app = express();
  app.use(express.json());
  registerAiJobRoutes(app, options);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

test('uses the local parser without an API key', async (t) => {
  let called = false;
  const origin = await startApp(t, { apiKey: '', fetchImpl: async () => { called = true; } });
  const response = await fetch(`${origin}/api/ai/intent`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: '서울 보건관리자' }),
  });
  const data = await response.json();
  assert.equal(response.status, 200);
  assert.equal(data.mode, 'local');
  assert.deepEqual(data.intent.regions, ['서울']);
  assert.equal(called, false);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('uses strict structured output without exposing the API key', async (t) => {
  let captured;
  const intent = {
    summary: '서울 보건관리자', regions: ['서울'], roleTags: ['health_manager'], employmentTypes: [],
    experienceLevel: 'any', includeKeywords: [], excludeKeywords: [], deadlineWithinDays: null,
    unresolvedCriteria: [], requiredFields: [],
  };
  const fetchImpl = async (_url, options) => {
    captured = options;
    return { ok: true, json: async () => ({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(intent) }] }] }) };
  };
  const origin = await startApp(t, { apiKey: 'secret-test-key', fetchImpl });
  const response = await fetch(`${origin}/api/ai/intent`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: '서울 보건관리자' }),
  });
  const data = await response.json();
  const requestBody = JSON.parse(captured.body);
  assert.equal(data.mode, 'openai');
  assert.equal(data.apiKey, undefined);
  assert.equal(requestBody.store, false);
  assert.equal(requestBody.text.format.type, 'json_schema');
  assert.equal(requestBody.text.format.strict, true);
  assert.equal(captured.headers.authorization, 'Bearer secret-test-key');
});

test('falls back locally for upstream failures and rejects empty or oversized input', async (t) => {
  const origin = await startApp(t, { apiKey: 'secret', fetchImpl: async () => ({ ok: false, status: 429 }) });
  const fallback = await fetch(`${origin}/api/ai/intent`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: '경기 산업간호사' }),
  });
  const fallbackData = await fallback.json();
  assert.equal(fallback.status, 200);
  assert.equal(fallbackData.mode, 'local-fallback');
  assert.deepEqual(fallbackData.intent.regions, ['경기']);

  const empty = await fetch(`${origin}/api/ai/intent`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: '  ' }),
  });
  assert.equal(empty.status, 400);
  const oversized = await fetch(`${origin}/api/ai/intent`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: '가'.repeat(401) }),
  });
  assert.equal(oversized.status, 400);
});

test('rejects refusal and incomplete Responses API payloads', async () => {
  const base = { apiKey: 'secret', timeoutMs: 100, model: 'test-model' };
  await assert.rejects(requestOpenAiIntent('서울', { ...base, fetchImpl: async () => ({ ok: true, json: async () => ({ status: 'incomplete', output: [] }) }) }), /no structured intent/);
  await assert.rejects(requestOpenAiIntent('서울', { ...base, fetchImpl: async () => ({ ok: true, json: async () => ({ status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'no' }] }] }) }) }), /no structured intent/);
});
