import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Regression tests for ADR-0019-desktop-app-iskeleti.md Karar (f) — "IPC
 * güvenlik modeli: v1'de tamamen kapalı allowlist". These tests read the
 * Rust-side config/source files as PLAIN TEXT/JSON — they never invoke
 * `cargo`, because this environment's MSVC linker (`link.exe`) is not
 * available, so `cargo build`/`cargo test` cannot run locally (only in the
 * Windows CI runner's `desktop-build` job, ADR-0019 Karar (e)). Everything
 * here is verifiable without compiling a single line of Rust.
 *
 * None of `apps/desktop/src-tauri/**` exists yet — every test below is
 * expected to fail RED (file-not-found / parse error) until `implementer`
 * creates the skeleton described in ADR-0019 Karar (c)/(f).
 */

const desktopRoot = path.dirname(fileURLToPath(import.meta.url));
const srcTauriRoot = path.join(desktopRoot, 'src-tauri');

function readSrcTauriFile(...segments: string[]): string {
  return readFileSync(path.join(srcTauriRoot, ...segments), 'utf-8');
}

describe('src-tauri/capabilities/default.json — zero-command allowlist', () => {
  it('exists and is valid JSON', () => {
    const filePath = path.join(srcTauriRoot, 'capabilities', 'default.json');
    expect(existsSync(filePath)).toBe(true);

    expect(() => JSON.parse(readFileSync(filePath, 'utf-8'))).not.toThrow();
  });

  it('grants EXACTLY ["core:default"] permissions — no opener, no plugin, no command', () => {
    const raw = readSrcTauriFile('capabilities', 'default.json');
    const parsed: unknown = JSON.parse(raw);

    expect(parsed).toMatchObject({ permissions: ['core:default'] });

    // Belt-and-suspenders: assert array length directly too, so a future
    // accidental append (e.g. re-adding `opener:default`) fails loudly even
    // if `toMatchObject`'s subset semantics were ever loosened above.
    const permissions = (parsed as { permissions: unknown }).permissions;
    expect(Array.isArray(permissions)).toBe(true);
    expect(permissions).toHaveLength(1);
    expect(permissions).toEqual(['core:default']);
  });
});

describe('src-tauri/src/lib.rs — no plugins registered, allowlist is explicit not empty (ADR-0019 Karar f, extended by ADR-0020)', () => {
  // ADR-0019 Karar (f)'s "zero-command allowlist" described the v1 SKELETON
  // only. F2-T3 PR3 (ADR-0020 Karar e/f/g) deliberately adds the first
  // command, `get_active_window_app_name`, under its own least-privilege
  // `desktop-signals` capability -- this is the natural extension ADR-0019
  // itself anticipated ("F2-T3 will add its own commands ... in its own
  // PR"), not a regression of the allowlist principle. What still must hold
  // is: no plugins, and `generate_handler!` is no longer empty but contains
  // EXACTLY the commands intentionally registered.
  it('does not register any Tauri plugin (.plugin( call)', () => {
    const source = readSrcTauriFile('src', 'lib.rs');
    expect(source).not.toContain('.plugin(');
  });

  it('generate_handler! is no longer empty — it contains exactly get_active_window_app_name (ADR-0020 Karar f, F2-T3 PR3)', () => {
    const source = readSrcTauriFile('src', 'lib.rs');
    const match = source.match(/generate_handler!\s*\[([^\]]*)\]/);

    expect(match).not.toBeNull();
    expect(match?.[1].trim()).toBe('get_active_window_app_name');
  });
});

describe('src-tauri/Cargo.toml — opener plugin dependency removed', () => {
  it('does not depend on tauri-plugin-opener', () => {
    const source = readSrcTauriFile('Cargo.toml');
    expect(source).not.toContain('tauri-plugin-opener');
  });
});

describe('src-tauri/tauri.conf.json — app identity configured', () => {
  it('exists, is valid JSON, and declares a non-empty reverse-DNS identifier', () => {
    const filePath = path.join(srcTauriRoot, 'tauri.conf.json');
    expect(existsSync(filePath)).toBe(true);

    const parsed: unknown = JSON.parse(readFileSync(filePath, 'utf-8'));
    expect(parsed).toHaveProperty('identifier');

    const identifier = (parsed as { identifier: unknown }).identifier;
    expect(typeof identifier).toBe('string');
    expect((identifier as string).length).toBeGreaterThan(0);
  });

  // security-reviewer finding (F2-T2b): `security.csp: null` disables
  // Tauri's default CSP injection entirely instead of declaring a
  // restrictive policy -- defense-in-depth against a compromised frontend
  // dependency or future XSS-capable render path. Pinned here so a later
  // change can't silently loosen it back to `null`/wide-open.
  it('declares a non-null, non-empty Content-Security-Policy', () => {
    const parsed: unknown = JSON.parse(readSrcTauriFile('tauri.conf.json'));
    const csp = (parsed as { app: { security: { csp: unknown } } }).app.security.csp;

    expect(typeof csp).toBe('string');
    expect((csp as string).length).toBeGreaterThan(0);
  });
});
