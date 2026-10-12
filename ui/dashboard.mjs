import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const template = path.join(path.dirname(fileURLToPath(import.meta.url)), 'dashboard.html');
export async function dashboardHtml(data) {
  const source = await readFile(template, 'utf8');
  return source.replace('/*__FIXTURE_DATA__*/', JSON.stringify(data).replace(/</g, '\\u003c'));
}
