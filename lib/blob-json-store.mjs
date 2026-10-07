function cloneJson(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

async function streamToText(stream) {
  if (typeof stream === 'string') return stream;
  if (stream instanceof Uint8Array) return new TextDecoder().decode(stream);
  if (stream && typeof stream.text === 'function') return stream.text();
  return new Response(stream).text();
}

/**
 * Creates a tiny JSON store backed by one Vercel Blob pathname.
 *
 * `getBlob` and `putBlob` mirror `get` and `put` from `@vercel/blob`. They are
 * injectable so callers can test the store without making network requests.
 */
export function createBlobJsonStore({
  pathname,
  seed,
  token = process.env.BLOB_READ_WRITE_TOKEN,
  access = 'private',
  getBlob,
  putBlob,
} = {}) {
  if (!pathname || typeof pathname !== 'string') throw new TypeError('pathname is required');
  if (access !== 'private' && access !== 'public') throw new TypeError("access must be 'private' or 'public'");
  if (getBlob !== undefined && typeof getBlob !== 'function') throw new TypeError('getBlob must be a function');
  if (putBlob !== undefined && typeof putBlob !== 'function') throw new TypeError('putBlob must be a function');

  let cached = false;
  let cachedValue;
  let readPromise;
  let sdkPromise;

  const initialValue = () => cloneJson(typeof seed === 'function' ? seed() : seed);
  const loadSdk = () => {
    sdkPromise ||= import('@vercel/blob');
    return sdkPromise;
  };
  const getImpl = getBlob || (async (...args) => (await loadSdk()).get(...args));
  const putImpl = putBlob || (async (...args) => (await loadSdk()).put(...args));

  async function read() {
    if (cached) return cloneJson(cachedValue);
    if (!token) return initialValue();

    readPromise ||= (async () => {
      const result = await getImpl(pathname, { access, token, useCache: false });
      cachedValue = result?.statusCode === 200 && result.stream
        ? JSON.parse(await streamToText(result.stream))
        : initialValue();
      cached = true;
      return cachedValue;
    })().finally(() => {
      readPromise = undefined;
    });

    return cloneJson(await readPromise);
  }

  async function write(value) {
    if (!token) throw new Error('BLOB_READ_WRITE_TOKEN is required to write Blob JSON');

    const payload = JSON.stringify(value);
    if (payload === undefined) throw new TypeError('value must be JSON serializable');

    const result = await putImpl(pathname, payload, {
      access,
      token,
      contentType: 'application/json',
      addRandomSuffix: false,
      allowOverwrite: true,
    });
    cachedValue = JSON.parse(payload);
    cached = true;
    return result;
  }

  function clearCache() {
    cached = false;
    cachedValue = undefined;
    readPromise = undefined;
  }

  return { read, write, clearCache };
}

