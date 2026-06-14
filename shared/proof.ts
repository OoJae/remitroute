// Deterministic execution proof attestation. Each agent action gets a content
// hash (keccak256) over its canonical fields, in the style of an ERC-8004
// Validation Registry digest. It is a real, reproducible hash of what the agent
// did, used by the public dashboard so any action can be independently verified.
// It is NOT an onchain validation submission (the money engine stays DRY_RUN).
import { keccak256, toHex } from "viem";

export interface ProofInput {
  id: string;
  kind: string;
  status: string;
  amountIn: string | null;
  tokenIn: string | null;
  amountOut: string | null;
  tokenOut: string | null;
  txHash: string | null;
  createdAt: Date | string | null;
}

// Canonical, stable serialization so the same action always hashes the same way
// and different actions almost never collide. Nulls normalize to empty strings.
export function executionProofHash(row: ProofInput): `0x${string}` {
  const createdAt =
    row.createdAt instanceof Date
      ? row.createdAt.toISOString()
      : (row.createdAt ?? "");
  const canonical = [
    row.id,
    row.kind,
    row.status,
    row.amountIn ?? "",
    row.tokenIn ?? "",
    row.amountOut ?? "",
    row.tokenOut ?? "",
    row.txHash ?? "",
    createdAt,
  ].join("|");
  return keccak256(toHex(canonical));
}
