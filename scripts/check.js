import { readdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? files(`${dir}/${entry.name}`) : [`${dir}/${entry.name}`]);
}
for (const file of [...files('server'), ...files('extension'), ...files('scripts')]) {
  if (file.endsWith('.js')) {
    const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    if (result.status !== 0) { console.error(result.stderr); process.exit(1); }
  }
}
const manifest = JSON.parse(readFileSync('extension/manifest.json', 'utf8'));
for (const path of [manifest.background.service_worker, manifest.action.default_popup, manifest.options_page,
  ...Object.values(manifest.icons)]) readFileSync(`extension/${path}`);
console.log('JavaScript syntax and extension manifest files verified.');
