// Engine selection.
//
// Resolution order, first usable match wins:
//   1. explicit request on the tool call
//   2. DUALOG_STRATEGY (operator-level default)
//   3. the adapter's own default
//
// An explicit request for an unsupported engine is a HARD ERROR: the caller
// asked for something specific and silently doing otherwise would be worse than
// failing. An operator-level default is a PREFERENCE and falls through with a
// warning, because one adapter that cannot do headless must not break a fleet
// setting that is right for all the others.

import { ENGINES } from "../adapters/schema.mjs";

export { ENGINES };

export function resolveEngine(adapter, { requested = null, env = process.env, log } = {}) {
  const sources = adapter.__sources?.join(" <- ") ?? "<unknown source>";

  if (requested) {
    if (!ENGINES.includes(requested)) {
      throw new Error(
        `Unknown engine "${requested}". Valid engines: ${ENGINES.join(", ")}`
      );
    }
    if (!adapter.engines.allowed.includes(requested)) {
      throw new Error(
        `Adapter "${adapter.id}" does not support engine "${requested}" ` +
          `(allowed: ${adapter.engines.allowed.join(", ")}). Declared in ${sources}`
      );
    }
    return requested;
  }

  const preferred = env.DUALOG_STRATEGY;
  if (preferred) {
    if (adapter.engines.allowed.includes(preferred)) return preferred;
    log?.(
      `DUALOG_STRATEGY=${preferred} is not supported by adapter "${adapter.id}" ` +
        `(allowed: ${adapter.engines.allowed.join(", ")}); using "${adapter.engines.default}" instead`
    );
  }

  return adapter.engines.default;
}
