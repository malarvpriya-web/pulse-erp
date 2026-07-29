// eventBus.js — Business Event Bus (Priority 8).
//
// A real, central pub/sub mechanism so cross-module reactions ("Commissioning
// completed -> Activate warranty") don't need direct imports between
// unrelated modules. This does NOT replace the 5 already-coexisting ad-hoc
// notification pathways documented in PULSE_EVENT_ORCHESTRATION_ARCHITECTURE.md
// (notificationsRepository.create / raw INSERT / WorkflowNotificationService /
// service_notifications / the broken notificationService.js) — consolidating
// those is a separate, much larger migration this pass deliberately doesn't
// attempt. This fills the layer above them: deciding WHAT should happen next
// when a business event occurs, wherever the reaction is actually handled.
import { EventEmitter } from 'node:events';

class PulseEventBus extends EventEmitter {}

export const eventBus = new PulseEventBus();
// This is an internal app-wide singleton with a growing set of registered
// reactions, not user input — raise the default cap (10) rather than let it
// silently start dropping listener registrations as more get added.
eventBus.setMaxListeners(50);

// A broken reaction must never take down the request that emitted the event
// (e.g. issuing a commissioning certificate must succeed even if the
// warranty-activation reaction throws) — errors are logged, not re-thrown.
export function onEvent(eventName, handler) {
  eventBus.on(eventName, async (payload) => {
    try {
      await handler(payload);
    } catch (err) {
      console.error(`[eventBus] handler for '${eventName}' failed:`, err.message);
    }
  });
}

export function emitEvent(eventName, payload) {
  eventBus.emit(eventName, payload);
}
