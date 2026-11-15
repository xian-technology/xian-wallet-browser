/**
 * The failure text of a simulation that did not succeed, or undefined when
 * it succeeded or reports no status. The simulator answers a failing call with a
 * non-zero status and the failure as its result; sending that call anyway
 * executes, fails and pays its chi.
 */
export function simulationFailure(simulation: unknown): string | undefined {
  if (typeof simulation !== "object" || simulation === null) {
    return undefined;
  }
  const { status, result } = simulation as { status?: unknown; result?: unknown };
  if (typeof status !== "number" || status === 0) {
    return undefined;
  }
  return typeof result === "string" ? result : JSON.stringify(result ?? "unknown failure");
}
