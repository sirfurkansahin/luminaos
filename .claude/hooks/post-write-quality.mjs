import { spawnSync } from 'node:child_process';
import path from 'node:path';

import { readStdinJson, toRelativePosix } from './lib/scope-check.mjs';

const PRETTIER_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.json', '.md', '.yml', '.yaml']);

function run(root, cmd, args) {
  const result = spawnSync(cmd, args, { cwd: root, encoding: 'utf8', shell: true });
  return { ok: result.status === 0, output: `$ ${cmd} ${args.join(' ')}\n${result.stdout ?? ''}${result.stderr ?? ''}` };
}

const data = await readStdinJson();
const filePath = data.tool_input?.file_path;
if (!filePath) {
  process.exit(0);
}

const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const rel = toRelativePosix(filePath);
const ext = path.extname(filePath);
const errors = [];

if (PRETTIER_EXTS.has(ext)) {
  const result = run(root, 'pnpm', ['exec', 'prettier', '--write', filePath]);
  if (!result.ok) errors.push(result.output);
}

if (ext === '.ts' || ext === '.tsx') {
  const result = run(root, 'pnpm', ['exec', 'eslint', '--fix', filePath]);
  if (!result.ok) errors.push(result.output);
}

const pkgMatch = rel.match(/^(packages|apps)\/([^/]+)\//);
if (pkgMatch) {
  const pkgDir = `${pkgMatch[1]}/${pkgMatch[2]}`;
  const result = run(root, 'pnpm', ['--filter', `./${pkgDir}`, 'test']);
  if (!result.ok) errors.push(result.output);
}

if (errors.length > 0) {
  console.error(errors.join('\n\n'));
  process.exit(2);
}

process.exit(0);
