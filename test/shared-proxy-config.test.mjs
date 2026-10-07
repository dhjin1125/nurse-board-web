import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

test('shared Caddy imports durable stock-flow route fragments', () => {
  const root = read('../deploy/iwinv/Caddyfile');
  const flow90 = read('../deploy/iwinv/caddy.d/flow90.caddy');
  const usPair = read('../deploy/iwinv/caddy.d/soxl-soxs.caddy');

  assert.match(root, /import \/etc\/caddy\/caddy\.d\/\*\.caddy/);
  assert.match(flow90, /reverse_proxy flow-lab:8000/);
  assert.match(flow90, /header X-Flow90-Origin-Auth \{\$FLOW90_ORIGIN_AUTH\}/);
  assert.match(flow90, /request_header -X-Flow90-Origin-Auth/);
  assert.match(usPair, /reverse_proxy soxl-soxs-lab:8000/);

  for (const source of [root, flow90, usPair]) {
    assert.doesNotMatch(source, /(?<![0-9a-f])[0-9a-f]{64}(?![0-9a-f])/);
  }
});

test('shared Caddy recreation retains secret config and both Docker networks', () => {
  const compose = read('../deploy/iwinv/docker-compose.yml');
  const validator = read('../deploy/iwinv/validate-shared-proxy.sh');

  assert.match(compose, /env_file:\s*\n\s*- \.\/\.env\.proxy/);
  assert.match(compose, /\.\/caddy\.d:\/etc\/caddy\/caddy\.d:ro/);
  assert.match(compose, /networks:\s*\n\s*- default\s*\n\s*- flow90_proxy/);
  assert.match(compose, /flow90_proxy:\s*\n\s*external: true\s*\n\s*name: flow90_proxy/);
  assert.match(validator, /caddy validate/);
  assert.match(validator, /nurse-board-iwinv_default/);
  assert.match(validator, /https:\/\/kospi-flow-lab\.vercel\.app\/healthz/);
  assert.match(validator, /https:\/\/soxl-soxs-flow-lab\.vercel\.app\/healthz/);
});
