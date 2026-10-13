#!/usr/bin/env node
import { importArtifact } from '../../agent-workflow/run-artifact.mjs';
const [runId, repo, repository, ...extra] = process.argv.slice(2);
if (!runId || !repo || !repository || extra.length) {
  console.error('Usage: node tools/run-artifact/import.mjs RUN_ID REPO_NAME LOCAL_CHECKOUT');
  process.exitCode = 1;
} else {
  try { console.log(JSON.stringify(await importArtifact(runId, { repo, repository }), null, 2)); }
  catch (error) {
    // Git errors can carry private paths and command text; keep the CLI summary bounded.
    console.error(error.stderr ? 'Git artifact verification failed; check the recorded base and repository.' : error.message);
    process.exitCode = 1;
  }
}
