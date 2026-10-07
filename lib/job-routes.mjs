import { jobPage } from './job-page.mjs';

export function registerJobRoutes(app, {
  jobService,
  getExtraSources,
  beforeRead = async () => {},
  awaitRefresh = false,
  cronSecret = process.env.CRON_SECRET,
  manualRefreshCooldownMs = 0,
}) {
  let lastManualRefreshStartedAt = 0;
  const effectiveManualRefreshCooldownMs = Math.max(0,
    Number.isFinite(Number(manualRefreshCooldownMs)) ? Number(manualRefreshCooldownMs) : 0);

  async function snapshotOptions() {
    return typeof getExtraSources === 'function'
      ? { extraSources: await getExtraSources() }
      : undefined;
  }

  async function readSnapshot() {
    const options = await snapshotOptions();
    return options ? jobService.getSnapshot(options) : jobService.getSnapshot();
  }

  async function readSnapshotPayload() {
    const options = await snapshotOptions();
    if (typeof jobService.getSnapshotPayload === 'function') {
      return options ? jobService.getSnapshotPayload(options) : jobService.getSnapshotPayload();
    }
    const snapshot = options ? await jobService.getSnapshot(options) : await jobService.getSnapshot();
    return { snapshot, body: JSON.stringify(snapshot) };
  }

  app.get('/api/health', async (_req, res) => {
    try {
      await beforeRead();
      return res.json(await jobService.getHealth());
    } catch {
      return res.status(503).json({ status: 'error', ready: false, error: '서버 캐시를 준비하지 못했습니다.' });
    }
  });

  app.get('/api/jobs', async (req, res) => {
    const personalized = req.query.ids != null || req.query.hidden != null || req.query.profile != null || req.query.discovery != null;
    res.setHeader('Cache-Control', personalized ? 'private, no-store' : 'no-store');
    try { jobPage({ jobs: [] }, req.query); }
    catch { return res.status(400).json({ error: '검색 조건이나 페이지 형식이 올바르지 않습니다.' }); }
    try {
      await beforeRead();
      const snapshot = await readSnapshot();
      let payload;
      try { payload = jobPage(snapshot, req.query); }
      catch { return res.status(400).json({ error: '검색 조건이나 페이지 형식이 올바르지 않습니다.' }); }
      const { body, gzip } = payload;
      res.setHeader('Cache-Control', personalized ? 'private, no-store' : 'public, max-age=0, s-maxage=30, stale-while-revalidate=300');
      res.vary('Accept-Encoding');
      if (gzip && req.acceptsEncodings('gzip')) {
        res.setHeader('Content-Encoding', 'gzip');
        return res.type('application/json').send(gzip);
      }
      return res.type('application/json').send(body);
    } catch {
      return res.status(500).json({
        jobs: [],
        needsReviewJobs: [],
        reviewJobs: [],
        error: '캐시된 공고를 불러오지 못했습니다.',
      });
    }
  });

  app.post('/api/refresh', async (_req, res) => {
    const now = Date.now();
    const remainingMs = Math.max(0, effectiveManualRefreshCooldownMs - (now - lastManualRefreshStartedAt));
    if (lastManualRefreshStartedAt && remainingMs > 0) {
      const retryAfterSeconds = Math.max(1, Math.ceil(remainingMs / 1000));
      res.setHeader('Retry-After', String(retryAfterSeconds));
      return res.status(429).json({
        accepted: false,
        error: `새 공고를 확인한 지 얼마 되지 않았습니다. ${retryAfterSeconds}초 후 다시 시도해 주세요.`,
        refresh: jobService.getRefreshState(),
      });
    }
    lastManualRefreshStartedAt = now;
    if (awaitRefresh) await beforeRead();
    const result = jobService.triggerRefresh('manual');
    if (awaitRefresh) await result.promise;
    const snapshot = awaitRefresh
      ? await readSnapshot()
      : undefined;
    return res.status(202).json({
      accepted: true,
      started: result.started,
      refresh: jobService.getRefreshState(),
      ...(snapshot ? { snapshot } : {}),
    });
  });

  app.get('/api/cron/refresh', async (req, res) => {
    if (!cronSecret || req.get('authorization') !== `Bearer ${cronSecret}`) {
      return res.status(401).json({ error: '허용되지 않은 자동 수집 요청입니다.' });
    }
    await beforeRead();
    const result = jobService.triggerRefresh('cron');
    await result.promise;
    const snapshot = await readSnapshot();
    return res.json({
      ok: true,
      started: result.started,
      refresh: jobService.getRefreshState(),
      counts: snapshot.counts,
      lastSuccessAt: snapshot.lastSuccessAt,
    });
  });
}
