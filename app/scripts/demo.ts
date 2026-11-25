// The page, in one command: starts a mainnet fork with a test wallet holding
// 100 USDC and serves the page for it. Because this process owns the fork, the
// page can also move the fork's clock forward a day.
//
//   pnpm run build && pnpm run demo
//
// MAINNET_RPC_URL and JUPITER_API_KEY are optional; without them the public
// endpoints are used, and they rate-limit.
import { access } from "node:fs/promises";
import { BUILT_PAGE, listen } from "../src/listen.ts";
import { createRouter } from "../src/router.ts";
import { createApp } from "../src/server.ts";
import { startFork } from "../src/testing/fork.ts";

await access(BUILT_PAGE).catch(() => {
  throw new Error("The page has not been built. Run: pnpm run build");
});
const fork = startFork();
const { signer } = await fork.newWallet(100_000_000n);
const app = createApp({ router: createRouter({ chain: fork.chain }), chain: fork.chain, signer, staticDir: BUILT_PAGE, advanceSeconds: fork.advanceSeconds });
const { server, url } = await listen(app, Number(process.env.ROUTER_PORT ?? 8787));

console.log(`Fork of mainnet running, with test wallet ${signer.address}: 100 USDC and 1 SOL, on this fork only.`);
console.log(`\nOpen ${url}\n\nCtrl-C stops the page and the fork.`);

await new Promise<void>((resolve) => {
  process.once("SIGINT", resolve);
  process.once("SIGTERM", resolve);
});
server.close();
server.closeAllConnections();
fork.stop();
