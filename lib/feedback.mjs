import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const FEEDBACK_CATEGORIES = Object.freeze(['bug', 'data', 'idea', 'other']);
export const FEEDBACK_MESSAGE_MAX_LENGTH = 1500;
const FEEDBACK_PREFIX = 'nurse-board/feedback/';
const RATE_LIMIT_WINDOW_MS = 10 * 60_000;
const MAX_SUBMISSIONS_PER_WINDOW = 5;

const asString = (value) => typeof value === 'string' ? value.trim() : '';

function httpError(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

function boundedText(value, maxLength) {
  const text = asString(value).replace(/\r\n?/g, '\n');
  return text.length <= maxLength ? text : '';
}

function normalizeContext(value) {
  const context = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const pagePath = boundedText(context.pagePath, 240);
  const viewport = ['mobile', 'tablet', 'desktop'].includes(context.viewport) ? context.viewport : '';
  const view = boundedText(context.view, 40);
  const jobId = boundedText(context.jobId, 160);
  const jobSource = boundedText(context.jobSource, 80);
  return Object.fromEntries(Object.entries({ pagePath, viewport, view, jobId, jobSource }).filter(([, item]) => item));
}

export function normalizeFeedback(payload, {
  now = () => new Date(),
  createId = () => randomUUID(),
} = {}) {
  const input = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  const category = FEEDBACK_CATEGORIES.includes(input.category) ? input.category : 'other';
  const message = asString(input.message).replace(/\r\n?/g, '\n');
  if (message.length < 4) throw httpError('피드백을 4자 이상 적어 주세요.');
  if (message.length > FEEDBACK_MESSAGE_MAX_LENGTH) {
    throw httpError(`피드백은 ${FEEDBACK_MESSAGE_MAX_LENGTH}자까지 남길 수 있습니다.`, 413);
  }
  const createdAt = now();
  const date = createdAt instanceof Date ? createdAt : new Date(createdAt);
  if (Number.isNaN(date.getTime())) throw new TypeError('now must return a valid date');
  const id = asString(createId());
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(id)) throw new TypeError('feedback id is invalid');
  return {
    version: 1,
    id,
    category,
    message,
    context: normalizeContext(input.context),
    status: 'new',
    createdAt: date.toISOString(),
  };
}

function feedbackFilename(record) {
  const timestamp = record.createdAt.replace(/[:.]/g, '-');
  return `${timestamp}__${record.id}.json`;
}

export function createFileFeedbackStore({ directory } = {}) {
  if (!directory) throw new TypeError('directory is required');

  async function write(record) {
    await mkdir(directory, { recursive: true });
    const target = join(directory, feedbackFilename(record));
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, target);
    return record;
  }

  async function list({ limit = 100 } = {}) {
    let names;
    try {
      names = await readdir(directory);
    } catch (error) {
      if (error?.code === 'ENOENT') return [];
      throw error;
    }
    const selected = names.filter((name) => /^\d{4}-\d{2}-\d{2}T.+__[A-Za-z0-9_-]{8,128}\.json$/.test(name))
      .sort((a, b) => b.localeCompare(a, 'en'))
      .slice(0, Math.max(1, Math.min(500, Number(limit) || 100)));
    const records = await Promise.all(selected.map(async (name) => {
      try {
        return JSON.parse(await readFile(join(directory, name), 'utf8'));
      } catch {
        return null;
      }
    }));
    return records.filter(Boolean).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }

  return { write, list };
}

export function createBlobFeedbackStore({
  token,
  putBlob,
  listBlobs,
  getBlob,
} = {}) {
  if (!token) throw new TypeError('token is required');
  let sdkPromise;
  const loadSdk = () => {
    sdkPromise ||= import('@vercel/blob');
    return sdkPromise;
  };
  const putImpl = putBlob || (async (...args) => (await loadSdk()).put(...args));
  const listImpl = listBlobs || (async (...args) => (await loadSdk()).list(...args));
  const getImpl = getBlob || (async (...args) => (await loadSdk()).get(...args));

  async function write(record) {
    const pathname = `${FEEDBACK_PREFIX}${record.createdAt.slice(0, 10)}/${feedbackFilename(record)}`;
    await putImpl(pathname, JSON.stringify(record), {
      access: 'private',
      token,
      contentType: 'application/json',
      addRandomSuffix: false,
      allowOverwrite: false,
    });
    return record;
  }

  async function list({ limit = 100 } = {}) {
    const cappedLimit = Math.max(1, Math.min(500, Number(limit) || 100));
    const blobs = [];
    let cursor;
    do {
      const result = await listImpl({ token, prefix: FEEDBACK_PREFIX, limit: 1000, ...(cursor ? { cursor } : {}) });
      blobs.push(...(result.blobs || []));
      cursor = result.hasMore ? result.cursor : undefined;
    } while (cursor && blobs.length < 5000);

    const selected = blobs
      .sort((a, b) => new Date(b.uploadedAt || 0).getTime() - new Date(a.uploadedAt || 0).getTime())
      .slice(0, cappedLimit);
    const records = await Promise.all(selected.map(async (blob) => {
      try {
        const result = await getImpl(blob.pathname, { access: 'private', token, useCache: false });
        if (result?.statusCode !== 200 || !result.stream) return null;
        return JSON.parse(await new Response(result.stream).text());
      } catch {
        return null;
      }
    }));
    return records.filter(Boolean).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }

  return { write, list };
}

export function createFeedbackStore({ token, directory } = {}) {
  return token ? createBlobFeedbackStore({ token }) : createFileFeedbackStore({ directory });
}

export function registerFeedbackRoutes(app, {
  store,
  allowRead = false,
  now = () => new Date(),
  createId = () => randomUUID(),
  maxSubmissionsPerWindow = MAX_SUBMISSIONS_PER_WINDOW,
} = {}) {
  if (!app || typeof app.post !== 'function' || typeof app.get !== 'function') throw new TypeError('Express app is required');
  if (!store || typeof store.write !== 'function' || typeof store.list !== 'function') throw new TypeError('feedback store is required');

  const submissions = new Map();
  const checkRateLimit = (key, at) => {
    const cutoff = at.getTime() - RATE_LIMIT_WINDOW_MS;
    const recent = (submissions.get(key) || []).filter((timestamp) => timestamp > cutoff);
    if (recent.length >= maxSubmissionsPerWindow) throw httpError('피드백을 연속으로 너무 많이 보냈습니다. 잠시 후 다시 시도해 주세요.', 429);
    recent.push(at.getTime());
    submissions.set(key, recent);
  };

  app.post('/api/feedback', async (req, res) => {
    res.set('cache-control', 'no-store, private');
    try {
      const at = now();
      const date = at instanceof Date ? at : new Date(at);
      if (asString(req.body?.website)) {
        return res.status(201).json({ ok: true, id: createId(), createdAt: date.toISOString() });
      }
      checkRateLimit(String(req.ip || req.socket?.remoteAddress || 'unknown'), date);
      const record = normalizeFeedback(req.body, { now: () => date, createId });
      await store.write(record);
      return res.status(201).json({ ok: true, id: record.id, createdAt: record.createdAt });
    } catch (error) {
      const status = Number.isInteger(error?.status) ? error.status : 503;
      return res.status(status).json({
        ok: false,
        error: status === 503 ? '피드백을 저장하지 못했습니다. 잠시 후 다시 시도해 주세요.' : error.message,
      });
    }
  });

  app.get('/api/feedback', async (req, res) => {
    res.set('cache-control', 'no-store, private');
    if (!allowRead) return res.status(404).json({ error: '찾을 수 없는 경로입니다.' });
    try {
      const feedback = await store.list({ limit: req.query?.limit });
      return res.json({ feedback, count: feedback.length });
    } catch {
      return res.status(503).json({ error: '피드백 목록을 불러오지 못했습니다.' });
    }
  });
}
