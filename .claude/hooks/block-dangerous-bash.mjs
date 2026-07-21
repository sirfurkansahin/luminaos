import { readStdinJson } from './lib/scope-check.mjs';

const RM_RF_PATTERNS = [
  /\brm\s+-[a-z]*r[a-z]*f[a-z]*\b/i, // -rf, -Rf, -rfv, ...
  /\brm\s+-[a-z]*f[a-z]*r[a-z]*\b/i, // -fr, -Fr, ...
  /\brm\s+-r\s+-f\b/i,
  /\brm\s+-f\s+-r\b/i,
  /\brm\s+(--recursive\b.*--force\b|--force\b.*--recursive\b)/i,
];

function hasDangerousRm(command) {
  return RM_RF_PATTERNS.some((pattern) => pattern.test(command));
}

function hasForcePush(command) {
  if (!/\bgit\s+push\b/i.test(command)) {
    return false;
  }
  return /(--force\b|--force-with-lease\b|\s-f\b)/.test(command);
}

function touchesEnvFile(command) {
  const refs = command.match(/\.env(\.[a-zA-Z0-9_-]+)?/g) ?? [];
  return refs.some((ref) => !ref.endsWith('.env.example'));
}

const data = await readStdinJson();
const command = String(data.tool_input?.command ?? '');

let reason = null;
if (hasDangerousRm(command)) {
  reason = "'rm -rf' (ve varyantlari) CLAUDE.md tarafindan yasaklanmis.";
} else if (hasForcePush(command)) {
  reason = "'git push --force' (ve varyantlari) CLAUDE.md tarafindan yasaklanmis.";
} else if (touchesEnvFile(command)) {
  reason = "'.env*' dosyalarina erisim (.env.example haric) CLAUDE.md tarafindan yasaklanmis.";
}

if (reason) {
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

process.exit(0);
