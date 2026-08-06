import '@testing-library/jest-dom/vitest';

// jsdom doesn't implement matchMedia — polyfill so components using
// useMediaQuery (mobile-breakpoint checks) don't crash under test. Defaults
// to "no match" (desktop layout) unless a test overrides window.matchMedia.
// Guarded on `window` existing: some test files opt into the `node`
// environment (// @vitest-environment node) for pure-logic tests with no DOM.
if (typeof window !== 'undefined' && typeof window.matchMedia !== 'function') {
  window.matchMedia = (query) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  });
}
