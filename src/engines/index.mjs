// Engine selection.
//
// Resolution order, first usable match wins:
//   1. explicit request on the tool call
//   2. DUALOG_STRATEGY (operator-level default)
//   3. the adapter's own default
//   4. WSL runtime availability on native Windows
//
// An explicit request for an unsupported engine is a HARD ERROR: the caller
// asked for something specific and silently doing otherwise would be worse than
// failing. An operator-level default is a PREFERENCE and falls through with a
// warning, because one adapter that cannot do headless must not break a fleet
// setting that is right for all the others.

import { ENGINES } from "../adapters/schema.mjs";
import {
  probeTmuxAvailability,
  probeWslPartnerCommand,
  tmuxRoute,
} from "../tmux-runtime.mjs";

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

/**
 * Resolve the engine that can actually start on this machine.
 *
 * A tool-call engine is a hard contract: requesting tmux explicitly keeps the
 * existing error when it cannot run. On native Windows, an adapter default or
 * DUALOG_STRATEGY preference may fall back to a declared headless path when the
 * WSL runtime cannot start. Native macOS/Linux keep their existing tmux
 * behavior. The WSL probe also verifies that the selected partner executable
 * can start inside that distribution.
 */
export async function resolveRunnableEngine(
  adapter,
  {
    requested = null,
    env = process.env,
    log,
    partnerCommand = null,
    probeTmuxAvailabilityFn = probeTmuxAvailability,
    probeWslPartnerCommandFn = probeWslPartnerCommand,
    tmuxRouteFn = tmuxRoute,
  } = {}
) {
  const engine = resolveEngine(adapter, { requested, env, log });
  if (engine !== "tmux-interactive") return engine;

  const route = tmuxRouteFn({ env });
  const availability = await probeTmuxAvailabilityFn();
  const command = partnerCommand || adapter.binary.default;
  let reason = null;

  if (availability !== "available") {
    reason =
      route.transport === "wsl"
        ? "WSL tmux is not available"
        : "tmux is not available";
  } else if (route.transport === "wsl") {
    const partnerStatus = await probeWslPartnerCommandFn(
      command,
      adapter.binary.versionArgs
    );
    if (partnerStatus !== "available") {
      reason = `WSL tmux is available, but partner command ${JSON.stringify(command)} could not run there`;
    }
  }

  if (!reason) return engine;
  if (
    route.transport === "wsl" &&
    !requested &&
    adapter.engines.allowed.includes("headless")
  ) {
    log?.(`${reason}; using "headless" for adapter "${adapter.id}" instead`);
    return "headless";
  }
  throw new Error(
    `${reason}. Adapter "${adapter.id}" requires a runnable tmux partner session.`
  );
}
