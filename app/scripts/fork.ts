// Starts a mainnet fork with a test wallet holding 100 USDC, prints how to
// point the commands at it, and runs until interrupted. The wallet's keypair
// is written to a new private folder under the system's temporary directory,
// never into the repository. It exists only on this fork.
//
//   MAINNET_RPC_URL=<your provider> pnpm run fork
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PUBLIC_MAINNET_RPC, startFork } from "../src/testing/fork.ts";

const fork = startFork();
const wallet = await fork.newWallet(100_000_000n);
const folder = await mkdtemp(join(tmpdir(), "yield-router-"));
const keypairPath = join(folder, "test-wallet.json");
await writeFile(keypairPath, JSON.stringify(wallet.secretKey), { mode: 0o600 });
await chmod(folder, 0o700);

console.log(`Fork of mainnet running${process.env.MAINNET_RPC_URL ? "" : ` (through ${PUBLIC_MAINNET_RPC}, which rate-limits)`}.`);
console.log(`Test wallet ${wallet.signer.address}: 100 USDC and 1 SOL, on this fork only.`);
console.log("\nIn another terminal:\n");
console.log(`export ROUTER_RPC_URL=${fork.chain.rpcUrl}`);
console.log(`export ROUTER_WS_URL=${fork.wsUrl}`);
console.log(`export ROUTER_KEYPAIR=${keypairPath}`);
console.log("pnpm run router compare\n\nCtrl-C stops the fork.");

// Signal handlers alone do not keep Node running; the timer does.
const keepAlive = setInterval(() => {}, 60_000);
await new Promise<void>((resolve) => {
  process.once("SIGINT", resolve);
  process.once("SIGTERM", resolve);
});
clearInterval(keepAlive);
fork.stop();
