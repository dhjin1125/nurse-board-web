const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const RETRYABLE_NETWORK = new Set(['TIMEOUT', 'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN', 'ETIMEDOUT', 'EPIPE', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET']);

export function createLimiter(concurrency = 6) {
  const limit = Math.max(1, Math.floor(Number(concurrency) || 1));
  let active = 0;
  const queue = [];
  function drain() {
    while (active < limit && queue.length) {
      const { task, resolve, reject } = queue.shift();
      active += 1;
      Promise.resolve().then(task).then(resolve, reject).finally(() => { active -= 1; drain(); });
    }
  }
  return (task) => new Promise((resolve, reject) => { queue.push({ task, resolve, reject }); drain(); });
}

export function collectionFailure(query, error) {
  return {
    query: String(query).slice(0, 100),
    code: String(error?.code || error?.cause?.code || error?.name || 'Error').replace(/[^A-Za-z0-9_]/g, '').slice(0, 80),
    ...(Number.isInteger(error?.httpStatus) ? { httpStatus: error.httpStatus } : {}),
    ...(Number.isInteger(error?.attempts) ? { attempts: error.attempts } : {}),
    ...(Number.isFinite(error?.durationMs) ? { durationMs: error.durationMs } : {}),
  };
}

export function searchCollectionResult(jobs, { settled, labels, previousJobs = [], preservePrevious = false, freshIds, includeDiagnostics = false, failureMessage }) {
  const failures = settled.flatMap((item, index) => item.status === 'rejected' ? [collectionFailure(labels[index], item.reason)] : []);
  const successfulQueries = settled.length - failures.length;
  const collection = { requestedQueries: settled.length, successfulQueries, failures };
  if (!successfulQueries && settled.length) throw Object.assign(new Error(failureMessage), { collection });
  const observedIds = freshIds || new Set(jobs.map((job) => job.id));
  const byId = new Map(jobs.map((job) => [job.id, job]));
  if (failures.length && preservePrevious) {
    for (const job of previousJobs) if (job?.id && !byId.has(job.id)) byId.set(job.id, job);
  }
  const result = [...byId.values()];
  collection.retainedJobIds = failures.length ? result.filter((job) => !observedIds.has(job.id)).map((job) => job.id) : [];
  return includeDiagnostics ? { jobs: result, collection } : result;
}

/** Only GET/HEAD and explicitly read-only POST requests can be retried. */
export function createCollectorRequest({ concurrency = 6, fetchImpl = (...args) => globalThis.fetch(...args), sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), retryDelayMs = 500, maxRetryDelayMs = 5000 } = {}) {
  const limited = createLimiter(concurrency);
  return async function request(url, { timeoutMs = 20_000, readOnlyPost = false, retries = 1, ...options } = {}) {
    const method = String(options.method || 'GET').toUpperCase();
    const retryAllowed = ['GET', 'HEAD'].includes(method) || (method === 'POST' && readOnlyPost);
    const maxAttempts = 1 + (retryAllowed ? Math.min(1, Math.max(0, Number(retries) || 0)) : 0);
    const host = new URL(url).hostname;
    let elapsedMs = 0;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      let retryAfterMs = retryDelayMs;
      try {
        return await limited(async () => {
          const started = Date.now();
          const timeout = AbortSignal.timeout(Math.max(1, Math.min(60_000, Number(timeoutMs) || 20_000)));
          try {
            const response = await fetchImpl(url, { ...options, signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout });
            if (!response.ok) {
              const header = response.headers.get('retry-after');
              if (header) retryAfterMs = /^\d+$/.test(header) ? Number(header) * 1000 : Math.max(0, Date.parse(header) - Date.now()) || retryDelayMs;
              await response.body?.cancel();
              throw Object.assign(new Error(), { httpStatus: response.status, code: `HTTP_${response.status}` });
            }
            // Keep the concurrency slot and timeout until the body has completed.
            return { bytes: await response.arrayBuffer(), contentType: response.headers.get('content-type') || '' };
          } catch (cause) {
            const code = timeout.aborted ? 'TIMEOUT' : String(cause.code || cause.cause?.code || cause.name || 'NETWORK_ERROR').replace(/[^A-Za-z0-9_]/g, '').slice(0, 80);
            elapsedMs += Date.now() - started;
            throw Object.assign(new Error(`${host}: ${code} (${attempt}회, ${elapsedMs}ms)`), { code, httpStatus: cause.httpStatus, attempts: attempt, durationMs: elapsedMs });
          }
        });
      } catch (error) {
        const transient = error.httpStatus ? RETRYABLE_STATUS.has(error.httpStatus) : RETRYABLE_NETWORK.has(error.code);
        if (attempt >= maxAttempts || !transient || options.signal?.aborted) throw error;
        // Backoff happens outside the slot so other sources can continue.
        await sleep(Math.min(maxRetryDelayMs, Math.max(retryDelayMs, retryAfterMs)));
      }
    }
  };
}
