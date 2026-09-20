// Measure tagged value moved straight from the chain, not from our database.
//
// Why this exists: the direct-send button in the Mini App is client side. The
// user's own wallet signs and broadcasts, and nothing is ever written to the
// executions table. So any query over `executions` measures only what our
// server did, and reports zero for money that genuinely moved. The leaderboard
// reads the chain, so this does too.
//
// It walks every wallet we know a real person signs from, lists their token
// transfers since the window opened, decodes each transaction's ERC-8021
// suffix, and counts only the ones carrying our registered tag. It then applies
// the Value Moved exclusions we can check locally: a transfer to yourself, and
// a transfer where either side is a wallet this project controls.
//
// Run: tsx openclaw/skills/remitroute-core/scripts/measure-tagged-volume.ts
//      [--since 2026-08-28] [--address 0x...] [--verbose]
import { verifyTx } from "@celo/attribution-tags";
import { formatUnits } from "viem";
import { db, pool } from "../../../../shared/db/client.js";
import { users } from "../../../../shared/db/schema.js";
import { publicClient } from "../../../../shared/viem.js";
import { config } from "../../../../shared/config.js";
import { log } from "../../../../shared/log.js";

// Wallets this project controls that are not per-user custodial wallets. The
// custodial ones are pulled from the database below, so this only needs the
// three standing ones.
const OPERATING_WALLETS = [
  "0x2b61FbdefEf22aBCc39645732a19842885f37F1c",
  "0x7111d20FcF6bd84E398Ab7940Ce5a97981432954",
  "0x63712F0f0A8dbC11f95e31399b9C9a224eE36BEB",
];

// Blockscout rejects urllib-style agents with a 403, and an unhandled 403 looks
// exactly like "this address has no history", which is the worst possible
// silent failure here. Send a browser agent and treat a non-200 as an error.
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";
const BLOCKSCOUT = "https://celo.blockscout.com/api/v2";

interface Transfer {
  hash: string;
  from: string;
  to: string;
  value: string;
  decimals: number;
  symbol: string;
  timestamp: string;
}

function parseArgs(argv: string[]): { since: string; extra: string[]; verbose: boolean } {
  const out = { since: "2026-08-28", extra: [] as string[], verbose: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--verbose") out.verbose = true;
    else if (a === "--since" && argv[i + 1]) { out.since = argv[i + 1]!; i += 1; }
    else if (a === "--address" && argv[i + 1]) { out.extra.push(argv[i + 1]!); i += 1; }
  }
  return out;
}

async function tokenTransfers(address: string, since: string): Promise<Transfer[]> {
  const out: Transfer[] = [];
  let next: string | null = null;
  for (let page = 0; page < 20; page += 1) {
    const qs = next ? `&${next}` : "";
    const url = `${BLOCKSCOUT}/addresses/${address}/token-transfers?type=ERC-20${qs}`;
    const res = await fetch(url, { headers: { "User-Agent": UA } });
    if (!res.ok) throw new Error(`blockscout ${res.status} for ${address}`);
    const body = (await res.json()) as { items?: unknown[]; next_page_params?: Record<string, unknown> | null };
    const items = body.items ?? [];
    let reachedEnd = false;
    for (const raw of items as Record<string, any>[]) {
      const ts = String(raw.timestamp ?? "");
      if (ts.slice(0, 10) < since) { reachedEnd = true; continue; }
      out.push({
        hash: String(raw.transaction_hash ?? raw.tx_hash ?? ""),
        from: String(raw.from?.hash ?? "").toLowerCase(),
        to: String(raw.to?.hash ?? "").toLowerCase(),
        value: String(raw.total?.value ?? raw.value ?? "0"),
        decimals: Number(raw.total?.decimals ?? raw.token?.decimals ?? 18),
        symbol: String(raw.token?.symbol ?? "?"),
        timestamp: ts,
      });
    }
    // Blockscout returns newest first, so once a page contains anything older
    // than the window we have everything we need.
    if (reachedEnd || !body.next_page_params) break;
    next = new URLSearchParams(body.next_page_params as Record<string, string>).toString();
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const tag = config.ATTRIBUTION_TAG;
  if (!tag) {
    log.error("ATTRIBUTION_TAG is not set, so nothing can be credited");
    process.exitCode = 1;
    return;
  }

  const rows = await db.select({ w: users.walletAddress, m: users.minipayAddress }).from(users);
  const projectControlled = new Set(
    [...OPERATING_WALLETS, ...rows.map((r) => r.w)].filter(Boolean).map((a) => String(a).toLowerCase()),
  );
  const signers = [
    ...new Set([...rows.map((r) => r.m).filter(Boolean).map(String), ...args.extra]),
  ].filter((a) => /^0x[0-9a-fA-F]{40}$/.test(a));

  console.log(`tag: ${tag}`);
  console.log(`window: ${args.since} onwards`);
  console.log(`signers to scan: ${signers.length}`);
  console.log(`project-controlled wallets (excluded as counterparties): ${projectControlled.size}\n`);

  // Collect the candidate transactions once, so a transaction seen from both
  // sides is only decoded a single time.
  const candidates = new Map<string, Transfer>();
  for (const s of signers) {
    try {
      for (const t of await tokenTransfers(s, args.since)) {
        if (t.hash && !candidates.has(t.hash)) candidates.set(t.hash, t);
      }
    } catch (err) {
      log.warn({ err, address: s }, "could not list transfers, skipping this address");
    }
  }
  console.log(`candidate transfers in window: ${candidates.size}`);

  let tagged = 0;
  let grossByToken: Record<string, number> = {};
  let eligibleByToken: Record<string, number> = {};
  const excluded: string[] = [];

  for (const [hash, t] of candidates) {
    const decoded = await verifyTx({ client: publicClient, hash: hash as `0x${string}` });
    if (!decoded || !decoded.codes.includes(tag)) continue;
    tagged += 1;
    const amount = Number(formatUnits(BigInt(t.value || "0"), t.decimals));
    grossByToken[t.symbol] = (grossByToken[t.symbol] ?? 0) + amount;

    // Value Moved exclusions we can evaluate without the organisers' graph.
    if (t.from === t.to) {
      excluded.push(`${hash.slice(0, 12)} self-transfer`);
      continue;
    }
    if (projectControlled.has(t.from) || projectControlled.has(t.to)) {
      excluded.push(`${hash.slice(0, 12)} counterparty is a wallet we control`);
      continue;
    }
    eligibleByToken[t.symbol] = (eligibleByToken[t.symbol] ?? 0) + amount;
    if (args.verbose) {
      console.log(`  ${t.timestamp.slice(0, 16)} ${amount.toFixed(4)} ${t.symbol} ${t.from.slice(0, 8)} -> ${t.to.slice(0, 8)} ${hash}`);
    }
  }

  const fmt = (m: Record<string, number>) =>
    Object.keys(m).length === 0 ? "  (none)" : Object.entries(m).map(([s, v]) => `  ${v.toFixed(4)} ${s}`).join("\n");

  console.log(`\ncarrying our tag: ${tagged}`);
  console.log(`\nGROSS tagged volume:\n${fmt(grossByToken)}`);
  console.log(`\nELIGIBLE after our own exclusions:\n${fmt(eligibleByToken)}`);
  if (excluded.length) {
    console.log(`\nexcluded by us (${excluded.length}):`);
    excluded.slice(0, 20).forEach((e) => console.log(`  ${e}`));
    if (excluded.length > 20) console.log(`  ...and ${excluded.length - 20} more`);
  }
  console.log(
    "\nNote: the organisers additionally discount a counterparty that we first funded, that shares our dominant funder, or that had no Celo token activity in the 60 days before 28 August. Those checks need their graph, so treat ELIGIBLE as an upper bound.",
  );
}

main()
  .catch((err) => {
    log.error({ err }, "measure-tagged-volume failed");
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
