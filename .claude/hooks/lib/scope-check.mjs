import path from 'node:path';

export async function readStdinJson() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

export function toRelativePosix(absPath) {
  const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const rel = path.relative(root, absPath);
  return rel.split(path.sep).join('/');
}

/**
 * Reads the PreToolUse hook payload from stdin, checks tool_input.file_path
 * against `isAllowed`, and denies (exit 2) with `denyMessage` if it fails.
 * Non Write/Edit tool calls (no file_path) pass through untouched.
 */
export async function enforceScope({ isAllowed, denyMessage }) {
  const data = await readStdinJson();
  const filePath = data.tool_input?.file_path;
  if (!filePath) {
    process.exit(0);
  }

  const rel = toRelativePosix(filePath);
  if (isAllowed(rel)) {
    process.exit(0);
  }

  const reason = denyMessage(rel);
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    }),
  );
  console.error(reason);
  process.exit(2);
}
