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

// jsdom does not implement the Pointer Events capture APIs (`hasPointerCapture`
// / `setPointerCapture` / `releasePointerCapture`) — real-browser APIs
// `@radix-ui/react-select`'s trigger (and `DropdownMenu`'s) call on pointer
// interactions. Without these no-op polyfills, clicking a `@luminaos/ui`
// `SelectTrigger` throws `TypeError: target.hasPointerCapture is not a
// function` (e.g. RecurrenceRulePicker.test.tsx's `selectFrequency` helper,
// which clicks the trigger then an option). Mirrors
// packages/ui/vitest.setup.ts's own identical shim.
if (typeof Element.prototype.hasPointerCapture !== 'function') {
  Element.prototype.hasPointerCapture = () => false;
}
if (typeof Element.prototype.setPointerCapture !== 'function') {
  Element.prototype.setPointerCapture = () => {
    // no-op: see comment above.
  };
}
if (typeof Element.prototype.releasePointerCapture !== 'function') {
  Element.prototype.releasePointerCapture = () => {
    // no-op: see comment above.
  };
}

// jsdom exposes `window.location.assign` as a non-configurable, non-writable
// own property (inherited straight off its internal `Location`
// implementation) -- neither `vi.spyOn(window.location, 'assign')` nor a
// plain `window.location.assign = fn` reassignment can override it (both
// throw `TypeError: Cannot redefine/assign to read only property 'assign'`).
// A real browser's `window.location.assign` IS a normal, spy-able method.
// The working jsdom workaround is to replace `window.location` itself
// (which IS configurable at the `window` property level) with a Proxy.
// `assign` is backed by a mutable local binding (`assignImpl`) so both
// plain reads AND `vi.spyOn(window.location, 'assign').mockImplementation(
// ...)` (which internally reads the current value, then calls
// `Object.defineProperty`/assignment to install its spy) work exactly like
// a normal spy-able method would. Every OTHER property (`search`,
// `pathname`, `href`, etc.) forwards straight through to the REAL, live
// jsdom Location object -- so `history.pushState`-driven navigation (which
// other hooks' tests, e.g. useViewParam/useObjectIdParam, rely on reading
// back via `window.location.search`) keeps working exactly as before.
// Getters are invoked with the REAL location object as `this` (via
// `Reflect.get(target, prop, target)`, not the proxy/receiver) since
// jsdom's native accessors do internal branding checks and throw "Illegal
// invocation" otherwise.
// The proxy's TARGET is a fresh, empty, extensible plain object -- not the
// real `Location` instance -- specifically so the `getOwnPropertyDescriptor`
// trap is free to report `assign` as configurable/writable. A Proxy MUST
// keep its trap results consistent with a NON-configurable own property on
// its actual target (the "invariant" check); proxying the real `Location`
// object directly (whose `assign` really is non-configurable) makes that
// invariant unsatisfiable and throws `TypeError: 'getOwnPropertyDescriptor'
// on proxy: trap returned descriptor for property 'assign' that is
// incompatible with the existing property in the proxy target` the moment
// `vi.spyOn` inspects it. An empty object has no such constraint.
let assignImpl: (url: string | URL) => void = () => {
  // no-op default: never let jsdom actually attempt navigation in tests
  // (e.g. IntegrationsPanel.test.tsx's OAuth-redirect assertion).
};
const realLocation = window.location;
const locationProxy = new Proxy(
  {},
  {
    get(_target, prop) {
      if (prop === 'assign') {
        return assignImpl;
      }
      const value = Reflect.get(realLocation, prop, realLocation) as unknown;
      return typeof value === 'function'
        ? (value as (...args: never[]) => unknown).bind(realLocation)
        : value;
    },
    getOwnPropertyDescriptor(_target, prop) {
      if (prop === 'assign') {
        return { configurable: true, writable: true, enumerable: true, value: assignImpl };
      }
      return Reflect.getOwnPropertyDescriptor(realLocation, prop);
    },
    defineProperty(_target, prop, descriptor) {
      if (prop === 'assign') {
        if ('value' in descriptor && typeof descriptor.value === 'function') {
          assignImpl = descriptor.value as typeof assignImpl;
        }
        return true;
      }
      return Reflect.defineProperty(realLocation, prop, descriptor);
    },
    set(_target, prop, value) {
      if (prop === 'assign') {
        assignImpl = value as typeof assignImpl;
        return true;
      }
      return Reflect.set(realLocation, prop, value, realLocation);
    },
    has(_target, prop) {
      return prop in realLocation;
    },
  },
);
Object.defineProperty(window, 'location', {
  configurable: true,
  writable: true,
  value: locationProxy,
});
