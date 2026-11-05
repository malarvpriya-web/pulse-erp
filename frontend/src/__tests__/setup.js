import '@testing-library/jest-dom';

// jsdom has no layout engine, so it does not implement Element#scrollIntoView.
// AddEmployee scrolls the first invalid field into view from a setTimeout after
// a failed save; in jsdom that threw "el?.scrollIntoView is not a function"
// outside any test, Vitest reported it as an unhandled error, and the run
// exited 1 although every test passed. A no-op is the honest stand-in: there is
// nothing to scroll in jsdom. Only added where the environment lacks it, so a
// real implementation (or a test's own spy) always wins.
if (typeof Element !== 'undefined' && typeof Element.prototype.scrollIntoView !== 'function') {
  Element.prototype.scrollIntoView = function scrollIntoView() {};
}
