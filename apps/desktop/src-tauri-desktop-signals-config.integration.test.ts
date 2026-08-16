import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * RED-step tests for ADR-0020-masaustu-sinyal-toplayicilar.md Karar (e)/(f)/(g)
 * — F2-T3 PR3 (masaüstü Tauri komutu + capability: `get_active_window_app_name`).
 *
 * Same technique as `apps/desktop/src-tauri-config.integration.test.ts`
 * (F2-T2b/ADR-0019): plain `node:fs` reads + string/regex/JSON assertions on
 * the Rust-side config/source files. Nothing here invokes `cargo` — this
 * environment's MSVC linker (`link.exe`) is unavailable, so `cargo
 * build`/`cargo clippy`/`cargo test` cannot run locally (only in the
 * Windows CI runner's `desktop-build` job).
 *
 * None of the files asserted on below exist yet (or, for
 * `capabilities/default.json`, exist but must remain byte-for-byte
 * unchanged) — every test is expected to fail RED (file-not-found / parse
 * error / assertion mismatch) until `implementer` creates them per ADR-0020
 * Karar (e)/(f)/(g).
 */

const desktopRoot = path.dirname(fileURLToPath(import.meta.url));
const srcTauriRoot = path.join(desktopRoot, 'src-tauri');

function readSrcTauriFile(...segments: string[]): string {
  return readFileSync(path.join(srcTauriRoot, ...segments), 'utf-8');
}

/**
 * Extracts the raw text of a TOML/INI-style `[section]` (up to the next
 * top-level `[`-prefixed header or end-of-file). Deliberately dumb/regex-only
 * — this is a text-content test, not a TOML parser.
 */
function extractSection(source: string, header: string): string {
  const escaped = header.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = source.match(new RegExp(`${escaped}\\s*\\n([\\s\\S]*?)(?=\\n\\[|$)`));
  return match ? match[1] : '';
}

describe('src-tauri/permissions/desktop-signals.toml — custom permission for get_active_window_app_name', () => {
  it('exists', () => {
    const filePath = path.join(srcTauriRoot, 'permissions', 'desktop-signals.toml');
    expect(existsSync(filePath)).toBe(true);
  });

  it('declares a [[permission]] block', () => {
    const source = readSrcTauriFile('permissions', 'desktop-signals.toml');
    expect(source).toContain('[[permission]]');
  });

  it('identifies as "allow-get-active-window-app-name"', () => {
    const source = readSrcTauriFile('permissions', 'desktop-signals.toml');
    expect(source).toMatch(/identifier\s*=\s*"allow-get-active-window-app-name"/);
  });

  it('allows exactly the "get_active_window_app_name" command', () => {
    const source = readSrcTauriFile('permissions', 'desktop-signals.toml');
    expect(source).toMatch(/commands\.allow\s*=\s*\[[^\]]*"get_active_window_app_name"[^\]]*\]/);
  });
});

describe('src-tauri/capabilities/desktop-signals.json — named, least-privilege capability (ADR-0020 Karar g)', () => {
  it('exists and is valid JSON', () => {
    const filePath = path.join(srcTauriRoot, 'capabilities', 'desktop-signals.json');
    expect(existsSync(filePath)).toBe(true);
    expect(() => JSON.parse(readFileSync(filePath, 'utf-8'))).not.toThrow();
  });

  it('is identified as "desktop-signals" and targets the "main" window', () => {
    const parsed = JSON.parse(readSrcTauriFile('capabilities', 'desktop-signals.json')) as {
      identifier?: unknown;
      windows?: unknown;
    };
    expect(parsed.identifier).toBe('desktop-signals');
    expect(parsed.windows).toEqual(['main']);
  });

  // Regression test for ADR-0020's corrected Karar (g): this is the app's
  // OWN command (not a plugin), so the permission is referenced WITHOUT a
  // plugin-style `desktop-signals:` prefix — exactly
  // `allow-get-active-window-app-name`, matching the `identifier` declared
  // in `permissions/desktop-signals.toml`. The ADR's own worked example
  // (`desktop-signals:allow-get-active-window-app-name`) was verified wrong
  // against real Tauri v2 docs and must NOT be what ships.
  it('references the permission WITHOUT a plugin-style prefix — permissions is EXACTLY ["allow-get-active-window-app-name"]', () => {
    const parsed = JSON.parse(readSrcTauriFile('capabilities', 'desktop-signals.json')) as {
      permissions?: unknown;
    };
    expect(Array.isArray(parsed.permissions)).toBe(true);
    expect(parsed.permissions).toEqual(['allow-get-active-window-app-name']);
  });
});

describe('src-tauri/capabilities/default.json — UNCHANGED, still zero-command (F2-T2b/ADR-0019 Karar f)', () => {
  it('is still EXACTLY {"identifier":"default","windows":["main"],"permissions":["core:default"]} — PR3 does not touch it', () => {
    const parsed: unknown = JSON.parse(readSrcTauriFile('capabilities', 'default.json'));
    expect(parsed).toEqual({
      identifier: 'default',
      windows: ['main'],
      permissions: ['core:default'],
    });
  });
});

describe('src-tauri/src/lib.rs — get_active_window_app_name command wired, no full window-title reads', () => {
  it('defines a #[tauri::command] fn get_active_window_app_name', () => {
    const source = readSrcTauriFile('src', 'lib.rs');
    expect(source).toMatch(
      /#\[tauri::command\]\s*(?:pub\s+)?(?:async\s+)?fn\s+get_active_window_app_name/,
    );
  });

  it('registers get_active_window_app_name in generate_handler! (no longer empty)', () => {
    const source = readSrcTauriFile('src', 'lib.rs');
    const match = source.match(/generate_handler!\s*\[([^\]]*)\]/);
    expect(match).not.toBeNull();
    expect(match?.[1] ?? '').toContain('get_active_window_app_name');
  });

  // ADR-0020 Karar (e), yerinde-işleme sınırı: the full window-title text is
  // never read anywhere in this file — only the foreground window's
  // process/application name (Karar f: GetForegroundWindow +
  // GetWindowThreadProcessId + process-name lookup).
  it('never calls GetWindowTextW (full window title text is forbidden, ADR-0020 Karar e)', () => {
    const source = readSrcTauriFile('src', 'lib.rs');
    expect(source).not.toContain('GetWindowTextW');
  });

  it('never calls GetWindowTextLengthW (full window title text is forbidden, ADR-0020 Karar e)', () => {
    const source = readSrcTauriFile('src', 'lib.rs');
    expect(source).not.toContain('GetWindowTextLengthW');
  });
});

describe('src-tauri/Cargo.toml — windows crate dependency added (ADR-0020 Karar f)', () => {
  it('declares "windows" as a [dependencies] entry', () => {
    const source = readSrcTauriFile('Cargo.toml');
    const dependenciesSection = extractSection(source, '[dependencies]');
    expect(dependenciesSection).toMatch(/^windows\s*=/m);
  });
});

describe('cross-file window-label consistency — desktop-signals.json targets the same window as default.json', () => {
  it('capabilities/desktop-signals.json "windows" matches capabilities/default.json "windows" (both ["main"])', () => {
    const desktopSignals = JSON.parse(readSrcTauriFile('capabilities', 'desktop-signals.json')) as {
      windows?: unknown;
    };
    const defaultCapability = JSON.parse(readSrcTauriFile('capabilities', 'default.json')) as {
      windows?: unknown;
    };

    expect(desktopSignals.windows).toEqual(defaultCapability.windows);
  });
});
