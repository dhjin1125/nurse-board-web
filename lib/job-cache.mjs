import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export const JOB_CACHE_VERSION = 1;

export function emptyJobCache() {
  return { version: JOB_CACHE_VERSION, savedAt: null, sources: {} };
}

export async function readJobCache(cacheFile) {
  try {
    const parsed = JSON.parse(await readFile(cacheFile, 'utf8'));
    if (parsed?.version !== JOB_CACHE_VERSION || !parsed.sources || typeof parsed.sources !== 'object') return emptyJobCache();
    return { version: JOB_CACHE_VERSION, savedAt: parsed.savedAt || null, sources: parsed.sources };
  } catch {
    return emptyJobCache();
  }
}

export async function writeJobCacheAtomic(cacheFile, cache) {
  await mkdir(dirname(cacheFile), { recursive: true });
  const temporary = `${cacheFile}.${process.pid}.${Date.now()}.tmp`;
  const payload = JSON.stringify({ ...cache, version: JOB_CACHE_VERSION }, null, 2);
  try {
    await writeFile(temporary, payload, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, cacheFile);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}
