/**
 * Console Error Capture
 *
 * Attaches to a Playwright Page and intercepts:
 *   • console.error / console.warn messages
 *   • Uncaught JS exceptions (pageerror)
 *   • Unhandled Promise rejections
 *   • Failed chunk / module imports (ChunkLoadError)
 *
 * Usage:
 *   const capture = attachConsoleCapture(page);
 *   // ... run test ...
 *   const errors = capture.flush();     // returns all captured issues
 *   capture.assertNone();               // throws if any errors were captured
 *   capture.detach();                   // removes listeners
 */

import type { Page, TestInfo } from '@playwright/test';

export interface CapturedConsoleEvent {
  type:      'error' | 'warning' | 'pageerror' | 'unhandled-rejection' | 'chunk-load-error';
  message:   string;
  url:       string;
  timestamp: string;
}

export interface ConsoleCapture {
  /** All captured events so far (not cleared). */
  events: CapturedConsoleEvent[];
  /** Errors only (type === 'error' | 'pageerror' | 'unhandled-rejection' | 'chunk-load-error') */
  errors: () => CapturedConsoleEvent[];
  /** Warnings only */
  warnings: () => CapturedConsoleEvent[];
  /** Flush and return all events, then clear the buffer. */
  flush: () => CapturedConsoleEvent[];
  /** Throw a descriptive error if any error-level events were captured. */
  assertNone: () => void;
  /** Attach all captured events to the Playwright test report. */
  attachToReport: (testInfo: TestInfo) => Promise<void>;
  /** Remove all listeners from the page. */
  detach: () => void;
}

/** Patterns that indicate a React ErrorBoundary / chunk failure */
const CRITICAL_PATTERNS = [
  /ChunkLoadError/i,
  /Loading chunk \d+ failed/i,
  /Cannot find module/i,
  /Failed to import/i,
  /Uncaught.*Error/i,
  /React ErrorBoundary/i,
  /Maximum update depth exceeded/i,
  /Cannot read propert/i,
  /is not a function/i,
  /undefined is not/i,
  /null is not/i,
];

const IGNORE_PATTERNS = [
  // Suppress noisy but harmless warnings
  /ResizeObserver loop limit exceeded/i,
  /ResizeObserver loop completed/i,
  /favicon\.ico/i,
  /Download the React DevTools/i,
  /\[HMR\]/i,
  /\[vite\]/i,
  /\[Fast Refresh\]/i,
];

function shouldIgnore(msg: string): boolean {
  return IGNORE_PATTERNS.some(p => p.test(msg));
}

function classifyMessage(msg: string): CapturedConsoleEvent['type'] {
  if (CRITICAL_PATTERNS.some(p => p.test(msg))) return 'error';
  return 'warning';
}

export function attachConsoleCapture(page: Page): ConsoleCapture {
  const buffer: CapturedConsoleEvent[] = [];
  const url = () => page.url();
  const ts  = () => new Date().toISOString();

  // ── console.error / console.warn ─────────────────────────────────────────────
  const onConsole = (msg: import('@playwright/test').ConsoleMessage) => {
    const type    = msg.type();
    const text    = msg.text();

    if (shouldIgnore(text)) return;

    if (type === 'error') {
      buffer.push({ type: 'error', message: text, url: url(), timestamp: ts() });
    } else if (type === 'warning' || type === 'warn') {
      buffer.push({ type: 'warning', message: text, url: url(), timestamp: ts() });
    }
  };

  // ── Uncaught JS exceptions ────────────────────────────────────────────────────
  const onPageError = (error: Error) => {
    const text = error.message || String(error);
    if (shouldIgnore(text)) return;

    const type = text.toLowerCase().includes('chunk') ? 'chunk-load-error' : 'pageerror';
    buffer.push({ type, message: text, url: url(), timestamp: ts() });
  };

  page.on('console',   onConsole);
  page.on('pageerror', onPageError);

  const capture: ConsoleCapture = {
    events: buffer,

    errors: () => buffer.filter(e =>
      e.type === 'error' || e.type === 'pageerror' ||
      e.type === 'unhandled-rejection' || e.type === 'chunk-load-error'
    ),

    warnings: () => buffer.filter(e => e.type === 'warning'),

    flush: () => {
      const copy = [...buffer];
      buffer.length = 0;
      return copy;
    },

    assertNone: () => {
      const errs = capture.errors();
      if (errs.length === 0) return;
      const summary = errs
        .slice(0, 5)
        .map(e => `[${e.type}] ${e.message.slice(0, 120)}`)
        .join('\n');
      throw new Error(`Console errors captured (${errs.length} total):\n${summary}`);
    },

    attachToReport: async (testInfo: TestInfo) => {
      if (buffer.length === 0) return;

      const lines = buffer.map(e =>
        `[${e.timestamp}] [${e.type.toUpperCase()}] ${e.url}\n  ${e.message}`
      ).join('\n\n');

      await testInfo.attach('console-capture.txt', {
        body:        Buffer.from(lines, 'utf8'),
        contentType: 'text/plain',
      });

      // Add short summary as annotation
      const errorCount   = capture.errors().length;
      const warningCount = capture.warnings().length;

      if (errorCount > 0) {
        testInfo.annotations.push({
          type:        'console-error',
          description: `${errorCount} console error(s), ${warningCount} warning(s) captured — see attachment`,
        });
      }
    },

    detach: () => {
      page.off('console',   onConsole);
      page.off('pageerror', onPageError);
    },
  };

  return capture;
}
