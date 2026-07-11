// Pure savings-goal lock arithmetic, dependency-free (no DB, no Aave, no Mento)
// so it is unit-testable without loading the heavy money stack. shared/goals.ts
// re-exports these; the withdraw gate and verify-safety use them.

// A withdrawal is refused when the amount requested would take the live position
// below the USD value locked by active goals. The epsilon absorbs float noise so
// a full-position withdraw of an unlocked goal is not spuriously blocked.
export function lockBreached(requestedUsd: number, positionUsd: number, lockedUsd: number): boolean {
  return requestedUsd > positionUsd - lockedUsd + 1e-9;
}

// The USD one active locked goal protects: min(accumulated, target), floored at
// zero. Sum across goals for the total.
export function goalLockedUsd(progressUsd: number, targetUsd: number): number {
  return Math.max(0, Math.min(progressUsd, targetUsd));
}
