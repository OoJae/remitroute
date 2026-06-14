// Execution-wallet helper. Mints a dedicated agent-managed sub-wallet for a user
// and returns its address plus the encrypted key reference to store in Postgres.
// The plaintext key is never returned or logged.
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { encryptKey } from "./crypto.js";

export interface NewExecutionWallet {
  address: `0x${string}`;
  keyRef: string;
}

export function createExecutionWallet(): NewExecutionWallet {
  const pk = generatePrivateKey();
  const account = privateKeyToAccount(pk);
  return { address: account.address, keyRef: encryptKey(pk) };
}
