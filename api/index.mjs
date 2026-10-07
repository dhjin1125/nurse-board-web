import express from 'express';
import { registerIwinvRelay } from '../lib/api-relay.mjs';
import { createPublishedFeed, registerPublishedFeedRoutes } from '../lib/published-feed.mjs';

// List reads use the collector's published data without importing the collectors.
// Explicit collection requests still go to IWINV.
export function createApiApp({
  origin = process.env.IWINV_API_ORIGIN,
  token = process.env.IWINV_RELAY_TOKEN,
  feed = process.env.BLOB_READ_WRITE_TOKEN ? createPublishedFeed() : null,
  loadLocalApp = () => import('../server.mjs').then(({ app }) => app),
} = {}) {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '1mb' }));
  if (feed) registerPublishedFeedRoutes(app, feed);
  let relayOrigin = '';
  try {
    const url = new URL(String(origin || ''));
    if (url.protocol === 'https:') relayOrigin = url.origin;
  } catch {}
  registerIwinvRelay(app, { origin: relayOrigin, token: String(token || '').trim(), localReads: Boolean(feed) });
  let localApp;
  app.use(async (req, res, next) => {
    try {
      localApp ||= Promise.resolve().then(loadLocalApp).catch((error) => { localApp = undefined; throw error; });
      return (await localApp)(req, res, next);
    } catch (error) { return next(error); }
  });
  return app;
}

export default createApiApp();
