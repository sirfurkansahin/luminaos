import { spawnSync } from 'node:child_process';

const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();

function run(cmd, args) {
  return spawnSync(cmd, args, { cwd: root, encoding: 'utf8', shell: true });
}

const typecheck = run('pnpm', ['typecheck']);
if (typecheck.status !== 0) {
  console.error(`pnpm typecheck basarisiz:\n${typecheck.stdout ?? ''}${typecheck.stderr ?? ''}`);
  process.exit(2);
}

const test = run('pnpm', ['test:changed']);
if (test.status !== 0) {
  console.error(`pnpm test:changed basarisiz:\n${test.stdout ?? ''}${test.stderr ?? ''}`);
  process.exit(2);
}

process.exit(0);
