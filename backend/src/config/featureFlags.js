/**
 * Feature flags — Pulse ERP platform engines.
 *
 * Convention: opt-out (default ON).
 *   Unset → enabled.   Set to the exact string "false" → disabled.
 *   Any other value    → enabled (e.g. "true", "1", "yes" all mean ON).
 *
 * This module is imported once; call logFeatureFlags() in the server startup
 * callback to print the active state table alongside the port announcement.
 */

function isEnabled(envKey) {
  return process.env[envKey] !== 'false';
}

export const flags = Object.freeze({
  WORKFLOW_ENGINE_ENABLED:     isEnabled('WORKFLOW_ENGINE_ENABLED'),
  RULE_ENGINE_ENABLED:         isEnabled('RULE_ENGINE_ENABLED'),
  VALIDATION_ENGINE_ENABLED:   isEnabled('VALIDATION_ENGINE_ENABLED'),
  NOTIFICATION_ENGINE_ENABLED: isEnabled('NOTIFICATION_ENGINE_ENABLED'),
});

export function logFeatureFlags() {
  const lines = Object.entries(flags).map(([name, on]) =>
    `  ${on ? '✅' : '🔴'}  ${name.padEnd(32)} ${on ? 'ENABLED' : 'DISABLED'}`
  );
  console.log('\n── Feature Flags ' + '─'.repeat(38));
  lines.forEach(l => console.log(l));
  console.log('─'.repeat(55) + '\n');
}
