import test from 'node:test';
import assert from 'node:assert/strict';
import {
  COMPANY_REPUTATION_ACK,
  COMPANY_REPUTATION_REQUEST,
  COMPANY_REPUTATION_RESPONSE,
  companyDisplayName,
  companyReputationKey,
  findCompanyReputation,
  readCompanyReputationCache,
  rememberCompanyReputation,
  requestCompanyReputation,
} from '../src/company-reputation.js';

function memoryStorage() {
  const values = new Map();
  return {
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, String(value)); },
  };
}

function fakeWindow(responder) {
  const listeners = new Set();
  const windowRef = {
    location: { origin: 'https://nurse-board-ten.vercel.app' },
    addEventListener(type, listener) { if (type === 'message') listeners.add(listener); },
    removeEventListener(type, listener) { if (type === 'message') listeners.delete(listener); },
    postMessage(data) {
      if (data.type !== COMPANY_REPUTATION_REQUEST) return;
      responder?.(data, (responseData) => queueMicrotask(() => {
        for (const listener of listeners) listener({ source: windowRef, origin: windowRef.location.origin, data: responseData });
      }));
    },
  };
  return windowRef;
}

test('company identity strips legal markers consistently', () => {
  assert.equal(companyDisplayName('(주) 유플러스홈서비스'), '유플러스홈서비스');
  assert.equal(companyReputationKey('㈜유플러스 홈서비스'), '유플러스홈서비스');
});

test('local cache stores only allowlisted aggregate fields', () => {
  const storage = memoryStorage();
  const entry = rememberCompanyReputation(storage, '(주)유플러스홈서비스', [{
    id: 'blind',
    companyName: '유플러스홈서비스',
    rating: 2.5,
    reviewCount: 32,
    url: 'https://www.teamblind.com/kr/company/test/reviews',
    checkedAt: '2026-09-01T06:00:00.000Z',
    reviewText: '저장되면 안 되는 리뷰 본문',
    author: '익명',
  }], '2026-09-01T06:00:00.000Z');

  assert.equal(entry.sources[0].rating, 2.5);
  assert.equal(entry.sources[0].reviewCount, 32);
  assert.equal('reviewText' in entry.sources[0], false);
  assert.equal('author' in entry.sources[0], false);
  assert.equal(JSON.stringify(readCompanyReputationCache(storage)).includes('저장되면 안 되는'), false);
  assert.equal(findCompanyReputation(readCompanyReputationCache(storage), '유플러스홈서비스').sources.length, 1);
});

test('local cache rejects incomplete aggregates instead of turning missing values into zero', () => {
  const storage = memoryStorage();
  assert.equal(rememberCompanyReputation(storage, '빈회사', [{
    id: 'blind', companyName: '빈회사', rating: null, reviewCount: null,
    url: 'https://www.teamblind.com/kr/company/test/reviews', checkedAt: '2026-09-01T06:00:00.000Z',
  }], '2026-09-01T06:00:00.000Z'), null);
  assert.deepEqual(readCompanyReputationCache(storage).entries, []);
});

test('page bridge request requires an acknowledgement and sanitizes the response', async () => {
  const windowRef = fakeWindow((request, emit) => {
    emit({ type: COMPANY_REPUTATION_ACK, requestId: request.requestId });
    emit({
      type: COMPANY_REPUTATION_RESPONSE,
      requestId: request.requestId,
      result: {
        company: request.company,
        sources: [{
          id: 'blind', companyName: '유플러스홈서비스', rating: 2.5, reviewCount: 32,
          url: 'https://www.teamblind.com/kr/company/test/reviews', checkedAt: '2026-09-01T06:00:00.000Z',
          reviewText: '노출 금지',
        }],
      },
    });
  });
  const result = await requestCompanyReputation('유플러스홈서비스', { windowRef, bridgeTimeoutMs: 50, responseTimeoutMs: 100 });
  assert.equal(result.ok, true);
  assert.equal(result.sources[0].rating, 2.5);
  assert.equal('reviewText' in result.sources[0], false);
});

test('page bridge fails quickly when the unpacked extension is not active', async () => {
  const windowRef = fakeWindow();
  await assert.rejects(
    requestCompanyReputation('테스트회사', { windowRef, fetchImpl: null, bridgeTimeoutMs: 5, responseTimeoutMs: 50 }),
    (error) => error.code === 'BRIDGE_UNAVAILABLE',
  );
});

test('page bridge absence falls back to the same-origin aggregate API', async () => {
  const windowRef = fakeWindow();
  let request;
  const result = await requestCompanyReputation('하워드힐병원', {
    windowRef,
    bridgeTimeoutMs: 5,
    responseTimeoutMs: 50,
    fetchImpl: async (url, options) => {
      request = { url, options };
      return new Response(JSON.stringify({
        ok: true,
        company: '하워드힐병원',
        sources: [{
          id: 'jobplanet', companyName: '하워드힐병원', rating: 2, reviewCount: 1,
          url: 'https://www.jobplanet.co.kr/companies/462795/reviews/%ED%95%98%EC%9B%8C%EB%93%9C%ED%9E%90%EB%B3%91%EC%9B%90',
          checkedAt: '2026-09-01T06:00:00.000Z', reviewText: '클라이언트에 전달되면 안 됨',
        }],
        candidates: [],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  assert.equal(request.url, 'https://nurse-board-ten.vercel.app/api/company-reputation');
  assert.equal(request.options.method, 'POST');
  assert.equal(JSON.parse(request.options.body).company, '하워드힐병원');
  assert.equal(result.ok, true);
  assert.equal(result.sources[0].rating, 2);
  assert.equal(result.sources[0].reviewCount, 1);
  assert.equal('reviewText' in result.sources[0], false);
});
