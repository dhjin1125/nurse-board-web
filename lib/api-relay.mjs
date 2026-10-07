import { gzip } from 'node:zlib';
import { promisify } from 'node:util';

const compress = promisify(gzip);

const relayAttempted = Symbol('nurseBoardRelayAttempted');

const IWINV_PROXY_ROUTES = new Map([
  ['/api/health', { methods: new Set(['GET', 'HEAD']), fallback: false }],
  ['/api/jobs', { methods: new Set(['GET', 'HEAD']), fallback: true }],
  ['/api/job', { methods: new Set(['GET', 'HEAD']), fallback: true }],
  ['/api/refresh', { methods: new Set(['POST']), fallback: false }],
  ['/api/job-detail', { methods: new Set(['POST']), fallback: true }],
  ['/api/ai/intent', { methods: new Set(['POST']), fallback: true }],
  ['/api/import/nurscape', { methods: new Set(['POST', 'OPTIONS']), fallback: false }],
]);
const VERCEL_LOCAL_API_ROUTES = new Set(['/api/saved-sync', '/api/company-reputation', '/api/feedback', '/api/saramin-image']);

function isSaraminDetailRefresh(req, pathname) {
  if (pathname !== '/api/job-detail' || req.method !== 'POST' || req.body?.refresh !== true) return false;
  try {
    const url = new URL(String(req.body?.url || ''));
    return url.protocol === 'https:' && url.hostname === 'www.saramin.co.kr'
      && url.pathname === '/zf_user/jobs/relay/view' && /^\d{1,12}$/u.test(url.searchParams.get('rec_idx') || '');
  } catch { return false; }
}

function isCaseManagerDetailRequest(req, pathname) {
  if (pathname !== '/api/job-detail' || req.method !== 'POST') return false;
  try {
    const url = new URL(String(req.body?.url || ''));
    return url.protocol === 'https:' && url.hostname === 'www.casemanager.or.kr';
  } catch { return false; }
}

export function registerIwinvRelay(app, { origin, token, localReads = false }) {
  if (!origin || !token) return;
  app.use('/api', async (req, res, next) => {
    if (req[relayAttempted]) return next();
    let incomingUrl;
    try {
      incomingUrl = new URL(req.originalUrl, 'http://vercel-relay.invalid');
    } catch {
      return res.status(400).json({ error: '잘못된 API 경로입니다.' });
    }
    if (VERCEL_LOCAL_API_ROUTES.has(incomingUrl.pathname)) return next();
    if (localReads && (['/api/jobs', '/api/job'].includes(incomingUrl.pathname)
      || (incomingUrl.pathname === '/api/job-detail' && isCaseManagerDetailRequest(req, incomingUrl.pathname)))) return next();
    // Saramin detail reads need to keep the browser-origin-specific image
    // referer flow, so the on-demand refresh runs in the Vercel app itself.
    if (isSaraminDetailRefresh(req, incomingUrl.pathname)) return next();
    const route = IWINV_PROXY_ROUTES.get(incomingUrl.pathname);
    if (!route || !route.methods.has(req.method)) {
      return res.status(404).json({ error: '등록되지 않은 API 경로입니다.' });
    }
    req[relayAttempted] = true;
    const target = new URL(`${incomingUrl.pathname}${incomingUrl.search}`, `${origin}/`);
    const headers = new Headers();
    for (const name of [
      'accept', 'content-type', 'origin', 'user-agent',
      'x-nurse-board-sync-token', 'x-nurse-board-sync-code',
      'access-control-request-method', 'access-control-request-headers',
    ]) {
      const value = req.get(name);
      if (value) headers.set(name, value);
    }
    headers.set('authorization', `Bearer ${token}`);
    const hasBody = !['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.body !== undefined;
    try {
      const upstream = await fetch(target, {
        method: req.method,
        headers,
        body: hasBody ? JSON.stringify(req.body) : undefined,
        redirect: 'manual',
        signal: AbortSignal.timeout(['/api/jobs', '/api/job'].includes(incomingUrl.pathname)
          || (!req.body?.refresh && isCaseManagerDetailRequest(req, incomingUrl.pathname)) ? 3_000 : 30_000),
      });
      const contentType = upstream.headers.get('content-type') || '';
      const validJson = req.method === 'HEAD'
        || req.method === 'OPTIONS'
        || /(?:^|[/+])json(?:\s*;|$)/i.test(contentType);
      if (upstream.status >= 500 || !validJson) {
        if (route.fallback) {
          res.setHeader('x-nurse-board-api-origin', 'vercel-fallback');
          return next();
        }
        res.setHeader('x-nurse-board-api-origin', 'iwinv-unavailable');
        return res.status(503).json({ error: 'IWINV 수집 서버에 연결하지 못했습니다.' });
      }
      // Finish and validate the body before committing a cacheable 200 response.
      // A timeout halfway through streaming otherwise poisons the CDN cache.
      const hasResponseBody = req.method !== 'HEAD' && upstream.status !== 204 && upstream.status !== 304;
      let body = hasResponseBody ? Buffer.from(await upstream.arrayBuffer()) : null;
      if (hasResponseBody && req.method !== 'OPTIONS') JSON.parse(body.toString('utf8'));
      const compressed = body?.length >= 1024 && req.acceptsEncodings('gzip');
      if (compressed) body = await compress(body);
      for (const name of [
        'content-type', 'cache-control', 'retry-after', 'vary',
        'access-control-allow-origin', 'access-control-allow-methods',
        'access-control-allow-headers', 'access-control-max-age',
      ]) {
        const value = upstream.headers.get(name);
        if (value) res.setHeader(name, value);
      }
      res.setHeader('x-nurse-board-api-origin', 'iwinv');
      res.status(upstream.status);
      if (!hasResponseBody) return res.end();
      res.vary('Accept-Encoding');
      if (compressed) res.setHeader('content-encoding', 'gzip');
      return res.send(body);
    } catch {
      if (res.headersSent) {
        res.destroy();
        return undefined;
      }
      if (route.fallback) {
        res.setHeader('x-nurse-board-api-origin', 'vercel-fallback');
        return next();
      }
      res.setHeader('x-nurse-board-api-origin', 'iwinv-unavailable');
      return res.status(503).json({ error: 'IWINV 수집 서버에 연결하지 못했습니다.' });
    }
  });
}
