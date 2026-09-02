// One way to obtain the catalog that validation is performed against.
//
// There are three places a model/effort pair gets checked -- check_adapter, the
// start-tool preflight, and the argv builder at turn time -- and they are only
// useful if they agree. They agreed when all three consulted the manifest, and
// they stopped agreeing the moment one of them learned to fetch a live catalog:
// the preflight would accept an effort the live entry allows, create a session,
// and the runtime check would then refuse the turn against the manifest. That is
// precisely the vendor-change case runtime discovery exists to support, so the
// answer is to give all three the same input rather than to take it away from
// the one that has it.
//
// Never throws, and never blocks a spawn: discovery already degrades to the
// adapter's static list on any failure, and a null result here simply means
// validation falls back to the manifest, which is the old behavior.

import { ensureModelCapability, resolveDiscovery } from "./discovery.mjs";

export async function resolveDiscoveryForValidation(
  adapter,
  {
    model = null,
    projectPath = null,
    engine = null,
    partnerCommand = null,
    tmuxRoute = null,
    env = process.env,
    platform = process.platform,
    log,
  } = {}
) {
  // Discovery only contributes model-specific identity, effort and tool
  // capability checks. With no requested model there is no catalog entry to
  // validate, so starting a control subprocess is both unnecessary and, for a
  // direct runner using an interactive fixture, capable of delaying the real
  // tmux launch until the discovery timeout expires.
  if (!adapter || !model) return null;

  try {
    let discovered = await resolveDiscovery(adapter, {
      projectPath,
      engine,
      partnerCommand,
      env,
      platform,
      ...(tmuxRoute ? { tmuxRouteFn: () => tmuxRoute } : {}),
    });

    // The listing probe is bounded, so the model actually being used may not
    // have been capability-checked. A bounded gate is not a gate.
    if (model) {
      discovered = await ensureModelCapability(adapter, discovered, model, { env });
    }
    return discovered;
  } catch (err) {
    log?.(`Discovery failed during validation (continuing without it): ${err.message}`);
    return null;
  }
}
