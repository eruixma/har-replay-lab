#!/usr/bin/env node
/**
 * replay.mjs — 一键跑完 to-site → to-fixtures → serve
 *
 * 例：
 *   node scripts/replay.mjs captures/xxx.har
 *   node scripts/replay.mjs captures/xxx.har --port 3000
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);

if (!argv.length || argv[0].startsWith('-')) {
  console.error('用法: node scripts/replay.mjs <file.har> [--port 8787]');
  process.exit(1);
}

const har = argv[0];
const portIdx = argv.indexOf('--port');
const port = portIdx >= 0 ? argv[portIdx + 1] : '8787';

const run = (script, args) => {
  const r = spawnSync(process.execPath, [path.join(HERE, script), ...args], { stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
};

run('to-site.mjs', [har]);
run('to-fixtures.mjs', [har]);
run('serve.mjs', ['--port', String(port)]);
