import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const NURSCAPE_EXTENSION_ID = 'hnoonhnmaolblmbpmedgggbacifnhjjp';
export const NURSCAPE_EXTENSION_ORIGIN = `chrome-extension://${NURSCAPE_EXTENSION_ID}`;
export const NURSCAPE_IMPORT_LIMIT = 450;

const NURSCAPE_HOST_PATTERN = /^(?:[a-z0-9-]+\.)+nurscape\.net$/;
const NURSCAPE_DETAIL_PATH_PATTERN = /^\/Jobs\/Details\/(\d+)$/;

export class NurscapeImportError extends Error {
  constructor(message, statusCode = 400, details = undefined) {
    super(message);
    this.name = 'NurscapeImportError';
    this.statusCode = statusCode;
    this.details = details;
  }
}

function cleanText(value, limit) {
  return String(value ?? '').replace(/[\u200b\ufeff]/g, '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function isoNow(now) {
  const value = typeof now === 'function' ? now() : now ?? new Date();
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError('유효한 import 시각이 필요합니다.');
  return date.toISOString();
}

function validIsoOr(value, fallback) {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : fallback;
}

function targetPath(cachePath) {
  if (!cachePath) throw new TypeError('너스케입 캐시 경로가 필요합니다.');
  return cachePath instanceof URL ? fileURLToPath(cachePath) : path.resolve(String(cachePath));
}

export function validateNurscapeJob(rawJob) {
  if (!rawJob || typeof rawJob !== 'object' || Array.isArray(rawJob)) {
    return { ok: false, reason: '공고가 객체가 아닙니다.' };
  }

  const sourceId = cleanText(rawJob.id, 40);
  if (!/^\d+$/.test(sourceId)) return { ok: false, reason: '공고 ID는 숫자여야 합니다.' };

  let sourceUrl;
  try {
    sourceUrl = new URL(cleanText(rawJob.url, 2000));
  } catch {
    return { ok: false, reason: '공고 URL 형식이 잘못되었습니다.' };
  }

  if (sourceUrl.protocol !== 'https:') return { ok: false, reason: '공고 URL은 HTTPS여야 합니다.' };
  if (!NURSCAPE_HOST_PATTERN.test(sourceUrl.hostname)) return { ok: false, reason: '너스케입 하위 도메인만 허용됩니다.' };
  const pathId = sourceUrl.pathname.match(NURSCAPE_DETAIL_PATH_PATTERN)?.[1];
  if (!pathId) return { ok: false, reason: '너스케입 상세 공고 경로만 허용됩니다.' };
  if (pathId !== sourceId) return { ok: false, reason: 'payload ID와 URL의 공고 ID가 다릅니다.' };

  const title = cleanText(rawJob.title, 300);
  if (!title) return { ok: false, reason: '공고 제목이 비어 있습니다.' };

  const company = cleanText(rawJob.company, 120) || '너스케입 등록기관';
  const roleText = cleanText(rawJob.description || rawJob.role, 4000);
  const value = {
    id: `nurscape-${sourceId}`,
    company,
    title,
    source: '너스케입',
    category: /(보건관리|산업간호|사업장)/.test(`${title} ${roleText}`) ? 'health' : 'clinical',
    url: sourceUrl.href,
  };

  const optionalFields = {
    region: cleanText(rawJob.region, 60),
    deadline: cleanText(rawJob.deadline, 60),
    publishedAt: cleanText(rawJob.publishedAt, 60),
    experience: cleanText(rawJob.experience, 120),
    employment: cleanText(rawJob.employment, 120),
    description: roleText,
  };
  for (const [key, fieldValue] of Object.entries(optionalFields)) {
    if (fieldValue) value[key] = fieldValue;
  }
  return { ok: true, value };
}

export async function readNurscapeImportCache(cachePath, { fsApi = fs, cacheStore } = {}) {
  if (cacheStore) {
    const parsed = await cacheStore.read();
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.jobs)) {
      throw new Error('너스케입 캐시 형식이 잘못되었습니다.');
    }
    return parsed;
  }
  const filePath = targetPath(cachePath);
  try {
    const parsed = JSON.parse(await fsApi.readFile(filePath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.jobs)) {
      throw new Error('너스케입 캐시 형식이 잘못되었습니다.');
    }
    return parsed;
  } catch (error) {
    if (error?.code === 'ENOENT') return { updatedAt: null, sourceUpdatedAt: null, jobs: [] };
    throw error;
  }
}

export async function writeNurscapeImportCacheAtomic(cachePath, cache, {
  fsApi = fs,
  cacheStore,
  suffix = `${process.pid}-${randomUUID()}`,
} = {}) {
  if (cacheStore) {
    await cacheStore.write(cache);
    return;
  }
  const filePath = targetPath(cachePath);
  const directory = path.dirname(filePath);
  const temporaryPath = path.join(directory, `.${path.basename(filePath)}.${suffix}.tmp`);
  await fsApi.mkdir(directory, { recursive: true });
  try {
    await fsApi.writeFile(temporaryPath, `${JSON.stringify(cache, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    await fsApi.rename(temporaryPath, filePath);
  } catch (error) {
    try { await fsApi.unlink(temporaryPath); } catch {}
    throw error;
  }
}

export function prepareNurscapeImport(incomingJobs, existingCache, {
  now = new Date(),
  limit = NURSCAPE_IMPORT_LIMIT,
} = {}) {
  if (!Array.isArray(incomingJobs) || incomingJobs.length === 0) {
    throw new NurscapeImportError('공고가 없는 import 요청은 기존 캐시를 변경하지 않습니다.', 400);
  }

  const seenAt = isoNow(now);
  const legacySeenAt = validIsoOr(existingCache?.sourceUpdatedAt, validIsoOr(existingCache?.updatedAt, seenAt));
  const existingJobsById = new Map();
  for (const current of Array.isArray(existingCache?.jobs) ? existingCache.jobs : []) {
    if (!current || typeof current !== 'object' || !/^nurscape-\d+$/.test(String(current.id || ''))) continue;
    existingJobsById.set(current.id, {
      ...current,
      firstSeenAt: validIsoOr(current.firstSeenAt, legacySeenAt),
      lastSeenAt: validIsoOr(current.lastSeenAt, legacySeenAt),
    });
  }

  const jobsById = new Map();
  let inserted = 0;
  let updated = 0;
  let rejected = Math.max(0, incomingJobs.length - limit);
  const idsInRequest = new Set();

  for (const rawJob of incomingJobs.slice(0, limit)) {
    const validation = validateNurscapeJob(rawJob);
    if (!validation.ok || idsInRequest.has(validation.value?.id)) {
      rejected += 1;
      continue;
    }
    const job = validation.value;
    idsInRequest.add(job.id);
    const current = existingJobsById.get(job.id);
    if (current) {
      jobsById.set(job.id, {
        ...current,
        ...job,
        firstSeenAt: validIsoOr(current.firstSeenAt, legacySeenAt),
        lastSeenAt: seenAt,
      });
      updated += 1;
    } else {
      jobsById.set(job.id, { ...job, firstSeenAt: seenAt, lastSeenAt: seenAt });
      inserted += 1;
    }
  }

  if (inserted + updated === 0) {
    throw new NurscapeImportError('검증을 통과한 너스케입 공고가 없습니다.', 400, {
      received: incomingJobs.length,
      rejected,
    });
  }

  const cache = {
    ...(existingCache && typeof existingCache === 'object' ? existingCache : {}),
    updatedAt: seenAt,
    sourceUpdatedAt: seenAt,
    jobs: [...jobsById.values()],
  };
  return {
    cache,
    result: {
      received: incomingJobs.length,
      inserted,
      updated,
      rejected,
      sourceUpdatedAt: seenAt,
    },
  };
}

export async function importNurscapePayload(payload, {
  cachePath,
  now = new Date(),
  limit = NURSCAPE_IMPORT_LIMIT,
  fsApi = fs,
  cacheStore,
} = {}) {
  const incomingJobs = payload?.jobs;
  if (!Array.isArray(incomingJobs) || incomingJobs.length === 0) {
    throw new NurscapeImportError('공고가 없는 import 요청은 기존 캐시를 변경하지 않습니다.', 400);
  }
  const existingCache = await readNurscapeImportCache(cachePath, { fsApi, cacheStore });
  const prepared = prepareNurscapeImport(incomingJobs, existingCache, { now, limit });
  await writeNurscapeImportCacheAtomic(cachePath, prepared.cache, { fsApi, cacheStore });
  return prepared.result;
}

export function createNurscapeImportCors({ allowedOrigin = NURSCAPE_EXTENSION_ORIGIN } = {}) {
  return function nurscapeImportCors(req, res, next) {
    const origin = typeof req.get === 'function' ? req.get('origin') : req.headers?.origin;
    if (origin !== allowedOrigin) {
      return res.status(403).json({ error: '허용되지 않은 너스케입 브리지 Origin입니다.' });
    }

    res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Max-Age', '600');
    if (typeof res.vary === 'function') res.vary('Origin');
    else res.setHeader('Vary', 'Origin');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    return next();
  };
}

export function createNurscapeImportHandler({
  cachePath,
  now = () => new Date(),
  fsApi = fs,
  cacheStore,
  onImported,
} = {}) {
  if (onImported !== undefined && typeof onImported !== 'function') {
    throw new TypeError('onImported must be a function');
  }
  return async function nurscapeImportHandler(req, res) {
    try {
      const result = await importNurscapePayload(req.body, { cachePath, now, fsApi, cacheStore });
      try {
        await onImported?.(result);
      } catch {
        console.error('너스케입 import 후 공고 스냅샷 갱신에 실패했습니다. 다음 수집 때 다시 갱신합니다.');
      }
      return res.json(result);
    } catch (error) {
      if (error instanceof NurscapeImportError) {
        return res.status(error.statusCode).json({ error: error.message, ...(error.details ? { details: error.details } : {}) });
      }
      return res.status(500).json({ error: '너스케입 캐시 저장에 실패했습니다.' });
    }
  };
}
