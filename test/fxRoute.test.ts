import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// buyRoute sits directly in front of a money path: a fleet agent buys a priced
// FX route before it rebalances. If it ever threw, or ever blocked, a transient
// 429 from the route's own rate limiter would stop real money from moving. So the
// contract under test is narrow and absolute: on ANY failure it resolves null and
// never raises. The happy path needs a live payer and is covered by the on-chain
// verification, not here.

const selectResult: { rows: Array<Record<string, unknown>> } = { rows: [] };

vi.mock("../shared/db/client.js", () => ({
  db: {
    select: () => ({ from: () => ({ where: () => selectResult.rows }) }),
  },
  pool: { end: async () => {} },
}));
vi.mock("../shared/db/schema.js", () => ({ users: {} }));
// Never reached in these tests (buyRoute bails before decrypting), so this is a
// placeholder rather than a key: a real-looking one would only trip secret scanners.
vi.mock("../shared/crypto.js", () => ({
  decryptKey: () => "not-a-key",
}));

const fleetUser = {
  id: "u1",
  walletKeyRef: "v1.aa.bb.cc",
  isFleet: true,
};

describe("buyRoute best-effort contract", () => {
  beforeEach(() => {
    selectResult.rows = [fleetUser];
    process.env.X402_FLEET_ENABLED = "true";
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("is gated by X402_FLEET_ENABLED", async () => {
    const { fleetX402Enabled } = await import("../shared/fxRoute.js");
    process.env.X402_FLEET_ENABLED = "false";
    expect(fleetX402Enabled()).toBe(false);
    process.env.X402_FLEET_ENABLED = "true";
    expect(fleetX402Enabled()).toBe(true);
  });

  it("returns null for a non-fleet user, so a real user never pays for a quote", async () => {
    selectResult.rows = [{ ...fleetUser, isFleet: false }];
    const { buyRoute } = await import("../shared/fxRoute.js");
    await expect(
      buyRoute({ userId: "u1", tokenIn: "cUSD", tokenOut: "cKES", amountIn: "1" }),
    ).resolves.toBeNull();
  });

  it("returns null when the user is unknown", async () => {
    selectResult.rows = [];
    const { buyRoute } = await import("../shared/fxRoute.js");
    await expect(
      buyRoute({ userId: "nope", tokenIn: "cUSD", tokenOut: "cKES", amountIn: "1" }),
    ).resolves.toBeNull();
  });

  it("never throws when the payer wiring blows up", async () => {
    // No THIRDWEB_CLIENT_ID configured is the common case in CI.
    const { buyRoute } = await import("../shared/fxRoute.js");
    await expect(
      buyRoute({ userId: "u1", tokenIn: "cUSD", tokenOut: "cKES", amountIn: "1" }),
    ).resolves.toBeNull();
  });
});
