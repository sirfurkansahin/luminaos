import '@testing-library/jest-dom/vitest';

// @radix-ui/react-dismissable-layer (used by Dialog's modal outside-click
// dismissal) sets `document.body.style.pointerEvents = 'none'` while a modal
// layer is open, restoring it on close — a real-browser affordance that
// blocks stray pointer interaction with anything outside the dialog's own
// layer (which re-enables `pointerEvents: auto` on itself). @testing-library/
// user-event's `.click()` refuses to dispatch a pointer event against any
// target whose *computed* `pointer-events` is `none` (including
// `document.body` itself, e.g. TaskDetailPanel.test.tsx's "clicking outside
// the dialog content" case, which clicks `document.body` directly to prove
// Radix's outside-pointerdown dismissal flows through unbroken). jsdom has no
// concept of the visual click-blocking `pointer-events: none` exists for in a
// real browser, so neutralizing the setter here only affects test-environment
// interaction plumbing, not the assertion's intent.
Object.defineProperty(document.body.style, 'pointerEvents', {
  configurable: true,
  get() {
    return '';
  },
  set() {
    // no-op: see comment above.
  },
});

// jsdom does not implement `Element.prototype.scrollIntoView` — a real-browser
// layout API that @radix-ui/react-select's `SelectItem` calls when the
// content opens, to scroll the currently-selected item into view. Without
// this no-op polyfill, opening any `@luminaos/ui` Select in a test throws
// `TypeError: candidate?.scrollIntoView is not a function` (e.g.
// StatusPrioritySelect.test.tsx's "lists every option ... when opened" case).
if (typeof Element.prototype.scrollIntoView !== 'function') {
  Element.prototype.scrollIntoView = () => {
    // no-op: see comment above.
  };
}
