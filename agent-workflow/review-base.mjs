import http from 'node:http';
import { publicSourcePr } from './run-continuation.mjs';
import { ARTIFACT_RUN_ID } from './run-artifact-contract.mjs';

export function prepareReviewBase(socket, repo, runId, selection) {
  if (!socket?.startsWith('/') || !ARTIFACT_RUN_ID.test(runId)) return Promise.reject(Error('Invalid base preparation request'));
  return new Promise((resolve, reject) => {
    const fail = () => reject(Error(selection ? 'PR continuation unavailable; check publication and PR state' : 'Fresh GitHub base unavailable; check review publisher'));
    const req = http.request({ socketPath: socket, path: selection ? '/prepare-review' : '/prepare-base', method: 'POST', timeout: 120000,
      headers: { 'content-type': 'application/json' } }, res => {
      let text = '';
      res.on('data', b => { text += b; if (text.length > 2048) res.destroy(); });
      res.on('error', fail);
      res.on('end', () => {
        try {
          const value = JSON.parse(text);
          if (res.statusCode !== 200 || value.repo !== repo || value.run_id !== runId || value.ref !== `refs/heads/base/runs/${runId}`
            || !/^[a-f0-9]{40}$/.test(value.commit) || !Number.isFinite(Date.parse(value.observed_at))) return fail();
          if (selection && !publicSourcePr(value.source_pr)) return fail();
          resolve(value);
        } catch { fail(); }
      });
    });
    req.on('error', fail); req.on('timeout', () => req.destroy());
    req.end(JSON.stringify({ repo, run_id: runId, ...(selection ? { selection } : {}) }));
  });
}
