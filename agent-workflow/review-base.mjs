import http from 'node:http';
import { ARTIFACT_RUN_ID } from './run-artifact-contract.mjs';

export function prepareReviewBase(socket, repo, runId) {
  if (!socket?.startsWith('/') || !ARTIFACT_RUN_ID.test(runId)) return Promise.reject(Error('Invalid base preparation request'));
  return new Promise((resolve, reject) => {
    const fail = () => reject(Error('Fresh GitHub base unavailable; check review publisher'));
    const req = http.request({ socketPath: socket, path: '/prepare-base', method: 'POST', timeout: 120000,
      headers: { 'content-type': 'application/json' } }, res => {
      let text = '';
      res.on('data', b => { text += b; if (text.length > 2048) res.destroy(); });
      res.on('error', fail);
      res.on('end', () => {
        try {
          const value = JSON.parse(text);
          if (res.statusCode !== 200 || value.repo !== repo || value.run_id !== runId || value.ref !== `refs/heads/base/runs/${runId}`
            || !/^[a-f0-9]{40}$/.test(value.commit) || !Number.isFinite(Date.parse(value.observed_at))) return fail();
          resolve(value);
        } catch { fail(); }
      });
    });
    req.on('error', fail); req.on('timeout', () => req.destroy());
    req.end(JSON.stringify({ repo, run_id: runId }));
  });
}
