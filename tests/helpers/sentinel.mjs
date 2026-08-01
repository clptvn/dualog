// The recursion sentinel (DUALOG_ROLE / DUALOG_DEPTH) is inherited by every
// process dualog spawns -- and "a partner agent reviews this repo and runs its
// test suite" is a first-class workflow, so the suite itself frequently runs
// with DUALOG_DEPTH already set. partnerSentinelEnv() increments whatever it
// inherits, so a test asserting the baseline value of "1" silently becomes an
// assertion about the ambient environment instead of about the code.
//
// Tests that pin the sentinel must therefore establish their own baseline.
// Tests that deliberately exercise depth propagation should set the starting
// depth explicitly rather than relying on the absence of these variables.

const SENTINEL_VARS = ["DUALOG_ROLE", "DUALOG_DEPTH"];

/**
 * Remove the inherited sentinel from this process for the duration of the run.
 * Returns a restore function; callers that care can invoke it, but for a test
 * file the process-lifetime clear is usually what is wanted.
 */
export function clearRecursionSentinel() {
  const saved = new Map(SENTINEL_VARS.map((key) => [key, process.env[key]]));
  for (const key of SENTINEL_VARS) delete process.env[key];

  return function restoreRecursionSentinel() {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

/**
 * A copy of `env` with the sentinel stripped, for handing to a child process
 * that should start from depth 0.
 */
export function sentinelFreeEnv(env = process.env) {
  const copy = { ...env };
  for (const key of SENTINEL_VARS) delete copy[key];
  return copy;
}
