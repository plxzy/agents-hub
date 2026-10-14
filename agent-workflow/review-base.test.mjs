import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { prepareReviewBase } from './review-base.mjs';

test('fresh-base socket validates the immutable run identity and fails closed', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'base-socket-'));
  const socket = path.join(dir, 's'), run_id = 'r-20261014T000000Z-abcdef';
  let bad = false;
  const server = http.createServer(async (req, res) => {
    let body = ''; for await (const b of req) body += b;
    assert.equal(req.url, '/prepare-base'); assert.deepEqual(JSON.parse(body), { repo: 'vm', run_id });
    res.end(JSON.stringify({ repo: 'vm', run_id, ref: bad ? 'refs/heads/main' : `refs/heads/base/runs/${run_id}`,
      commit: 'a'.repeat(40), observed_at: new Date().toISOString() }));
  });
  await new Promise(resolve => server.listen(socket, resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await fs.rm(dir, { recursive: true }); });
  assert.equal((await prepareReviewBase(socket, 'vm', run_id)).commit, 'a'.repeat(40));
  bad = true;
  await assert.rejects(prepareReviewBase(socket, 'vm', run_id), /Fresh GitHub base unavailable/);
});
