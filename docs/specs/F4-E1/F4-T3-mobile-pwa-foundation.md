# F4-T3 — Mobile web and PWA foundation

**Epic:** F4-E1 (Public beta and release readiness)

**Status:** Implemented — beta device acceptance pending

## Goal

Make the existing web beta practical on a phone without introducing a paid
service or a native-platform dependency. The first mobile delivery is an
installable progressive web app (PWA); iOS and Android store packages remain a
follow-up only after beta usage validates the critical flows.

## Scope

- add mobile viewport, theme, application metadata, and an installable web app
  manifest;
- register a production-only service worker that never caches API requests;
- provide a responsive application shell with safe-area spacing and touch-sized
  controls;
- keep task views and primary actions visible while grouping non-critical
  administration panels under one accessible disclosure;
- preserve desktop behavior and all existing view/query contracts.

## Acceptance criteria

- [x] The production build includes a valid manifest and service worker.
- [x] Service-worker registration is disabled outside production and failures
      do not prevent application startup.
- [x] `/api/*` requests are never read from or written to an offline cache.
- [x] The shell works at 320 CSS pixels without page-level horizontal overflow.
- [x] Navigation and primary buttons have at least a 44-pixel touch target on
      narrow screens.
- [x] Advanced tools remain keyboard-accessible but do not push the critical
      task flow below a long wall of panels by default.
- [x] Existing web tests, typecheck, lint, and production build remain green.

## Verification

On 20 September 2026, all 995 web tests passed together with web typecheck,
lint, and production build. The live HTTPS deployment was exercised in
headless Chromium at 320×568 and in the in-app browser at both 320×568 and
390×844. In each case the document width matched the viewport width, the
advanced-tools disclosure was closed by default, and visible buttons met the
44-pixel touch target. Chromium registered `luminaos-shell-v1` at root scope,
confirmed that no cached request used an `/api/` path, then reloaded offline
and rendered the LuminaOS shell successfully. Real iOS Safari and Android
Chrome install prompts remain part of beta device acceptance.

## Explicit non-goals

- App Store or Play Store publication;
- native push notifications, background sync, or offline writes;
- caching authenticated API responses;
- redesigning individual board, calendar, table, or timeline interactions.
