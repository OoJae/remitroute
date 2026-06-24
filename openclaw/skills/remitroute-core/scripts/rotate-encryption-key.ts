// Re-encrypt every execution-wallet key under the CURRENT ENCRYPTION_KEY. Use it
// to rotate the at-rest encryption key with no downtime:
//   1. set ENCRYPTION_KEY=<new>, ENCRYPTION_KEY_PREVIOUS=<old>, bump
//      ENCRYPTION_KEY_VERSION
//   2. run this with --execute (decrypt falls back to the previous key, then
//      re-encrypts under the new one)
//   3. once it reports 0 failures, remove ENCRYPTION_KEY_PREVIOUS
// Preview-by-default. Each row is round-trip verified before its update, so a bad
// row is skipped without data loss.
import { eq } from "drizzle-orm";
import { db, pool } from "../../../../shared/db/client.js";
import { users } from "../../../../shared/db/schema.js";
import { decryptKey, encryptKey } from "../../../../shared/crypto.js";
import { log } from "../../../../shared/log.js";

async function main(execute: boolean): Promise<void> {
  const rows = await db.select().from(users);
  let rotated = 0;
  let previewed = 0;
  let failed = 0;
  for (const u of rows) {
    try {
      const plain = decryptKey(u.walletKeyRef);
      const next = encryptKey(plain);
      if (decryptKey(next) !== plain) {
        failed += 1;
        log.error({ userId: u.id }, "round-trip verification failed; leaving row unchanged");
        continue;
      }
      if (!execute) {
        previewed += 1;
        continue;
      }
      await db.update(users).set({ walletKeyRef: next }).where(eq(users.id, u.id));
      rotated += 1;
    } catch (err) {
      failed += 1;
      log.error({ err, userId: u.id }, "could not rotate row");
    }
  }
  log.info(
    { total: rows.length, rotated, previewed, failed, execute },
    execute ? "key rotation complete" : "key rotation PREVIEW; rerun with --execute",
  );
  await pool.end();
  if (failed > 0) process.exitCode = 1;
}

main(process.argv.includes("--execute")).catch((err) => {
  log.error({ err }, "rotate-encryption-key failed");
  process.exit(1);
});
