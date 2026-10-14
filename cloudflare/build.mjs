import { mkdir, writeFile } from 'node:fs/promises';
import { dashboardHtml } from '../ui/dashboard.mjs';
import { fixtures } from '../demo/fixtures.mjs';

await mkdir(new URL('./public/', import.meta.url), { recursive: true });
await writeFile(new URL('./public/index.html', import.meta.url), await dashboardHtml(fixtures));
console.log('Built the read-only fixture demo for Cloudflare Workers static assets.');
