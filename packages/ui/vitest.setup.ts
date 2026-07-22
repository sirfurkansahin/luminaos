import { vi } from 'vitest';

import '@testing-library/jest-dom/vitest';

// @testing-library/dom's `waitFor` auto-detects fake timers by checking
// whether the global `setTimeout` carries a `.clock` property (the
// @sinonjs/fake-timers implementation vitest's vi.useFakeTimers() uses under
// the hood), then advances them via a global `jest.advanceTimersByTime` call.
// Vitest does not provide a `jest` global, so alias it to `vi` — without this,
// any test combining vi.useFakeTimers() with waitFor()/findBy* hangs until
// the outer test timeout instead of advancing.
(globalThis as unknown as { jest?: typeof vi }).jest = vi;

// jsdom has no real layout engine and does not implement these DOM APIs that
// Radix UI's pointer/scroll-based interactions (Select, DropdownMenu) call at
// runtime. TypeScript's lib.dom.d.ts declares them as always present, so we
// assign unconditionally rather than feature-detecting.
Element.prototype.scrollIntoView = function scrollIntoView() {
  // no-op in jsdom
};

Element.prototype.hasPointerCapture = function hasPointerCapture() {
  return false;
};

Element.prototype.setPointerCapture = function setPointerCapture() {
  // no-op in jsdom
};

Element.prototype.releasePointerCapture = function releasePointerCapture() {
  // no-op in jsdom
};

// jsdom has no real display refresh loop, so window.requestAnimationFrame is
// only a timer-based approximation (even with pretendToBeVisual). Radix UI's
// Toast announcement region (@radix-ui/react-toast's useNextFrame) chains two
// rAF calls inside a layout effect before rendering its accessible text —
// with a deferred rAF, that text lands after React Testing Library's `act()`
// flush has already completed, making `findByRole('status')` resolve against
// an as-yet-empty element. Invoking the callback synchronously lets those
// layout-effect-scheduled updates flush within the same `act()` pass, which
// is a standard jsdom testing shim (jsdom has no frames to wait for).
let nextRafHandle = 0;
window.requestAnimationFrame = function requestAnimationFrame(callback) {
  nextRafHandle += 1;
  callback(performance.now());
  return nextRafHandle;
};
window.cancelAnimationFrame = function cancelAnimationFrame() {
  // no-op: the shim above already invoked the callback synchronously.
};
