import express from 'express';
import { fileURLToPath } from 'node:url';
import { createJobService } from '../lib/job-service.mjs';
import { createAiSourceDefinitions, AI_LINK_SOURCES } from './collectors.mjs';
import { prepareAiJob } from './ai-model.mjs';

try {
  process.loadEnvFile?.(fileURLToPath(new URL('./.env', import.meta.url)));
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}

const AI_CACHE = fileURLToPath(new URL('./data/ai-jobs-cache.json', import.meta.url));
const PUBLIC_ROOT = fileURLToPath(new URL('./public/', import.meta.url));
const MANUAL_REFRESH_COOLDOWN_MS = Math.max(0,
  Number(process.env.AI_BOARD_REFRESH_COOLDOWN_MS) || 45_000);

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb' }));

const jobService = createJobService({
  sources: createAiSourceDefinitions(),
  cacheFile: AI_CACHE,
  prepareJob: (job) => prepareAiJob(job),
});

let lastManualRefreshStartedAt = 0;

function snapshotPayload(snapshot) {
  const {
    jobs, needsReviewJobs, sourceStatus, lastAttemptAt, lastSuccessAt,
    updatedAt, stale, dataTrust, refresh, refreshInProgress, refreshing,
    emptyReason, sources,
  } = snapshot;
  return {
    jobs,
    needsReviewJobs,
    counts: {
      total: jobs.length,
      review: needsReviewJobs.length,
      ai: jobs.length,
    },
    sourceStatus,
    lastAttemptAt,
    lastSuccessAt,
    updatedAt,
    stale,
    dataTrust,
    refresh,
    refreshInProgress,
    refreshing,
    emptyReason,
    sources,
    linkSources: AI_LINK_SOURCES,
    generatedAt: new Date().toISOString(),
  };
}

app.get('/api/health', async (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    return res.json(await jobService.getHealth());
  } catch {
    return res.status(503).json({ status: 'error', ready: false, error: '캐시를 준비하지 못했습니다.' });
  }
});

app.get('/api/jobs', async (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const snapshot = await jobService.getSnapshot();
    return res.json(snapshotPayload(snapshot));
  } catch {
    return res.status(500).json({ jobs: [], needsReviewJobs: [], error: '캐시된 공고를 불러오지 못했습니다.' });
  }
});

app.post('/api/refresh', async (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const now = Date.now();
  const remainingMs = Math.max(0, MANUAL_REFRESH_COOLDOWN_MS - (now - lastManualRefreshStartedAt));
  if (lastManualRefreshStartedAt && remainingMs > 0) {
    const retryAfterSeconds = Math.max(1, Math.ceil(remainingMs / 1000));
    res.setHeader('Retry-After', String(retryAfterSeconds));
    return res.status(429).json({
      accepted: false,
      error: `${retryAfterSeconds}초 후 다시 시도해 주세요.`,
      refresh: jobService.getRefreshState(),
    });
  }
  lastManualRefreshStartedAt = now;
  const result = jobService.triggerRefresh('manual');
  return res.status(202).json({ accepted: true, started: result.started, refresh: jobService.getRefreshState() });
});

app.get('/api/refresh/status', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json(jobService.getRefreshState());
});

app.use(express.static(PUBLIC_ROOT));
app.use((req, res, next) => {
  if (req.method !== 'GET' || req.path.startsWith('/api/')) return next();
  return res.sendFile(fileURLToPath(new URL('./public/index.html', import.meta.url)),
    (error) => error ? next(error) : undefined);
});

export { app, jobService };

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 4374);
  const host = process.env.HOST || '127.0.0.1';
  await jobService.initialize();
  app.listen(port, host, () => console.log(`AI Board http://${host}:${port}`));
}
