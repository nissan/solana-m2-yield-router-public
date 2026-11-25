// The page for a fork that is already running (`pnpm run fork`), using the
// same three variables as the commands. `pnpm run demo` is the shorter way.
import { readFile } from "node:fs/promises";
import { createKeyPairSignerFromBytes } from "@solana/kit";
import { connect } from "../src/chain.ts";
import { BUILT_PAGE, listen } from "../src/listen.ts";
import { createRouter } from "../src/router.ts";
import { createApp } from "../src/server.ts";

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set. Start a fork with "pnpm run fork" and paste the lines it prints.`);
  return value;
}

const chain = connect(env("ROUTER_RPC_URL"), env("ROUTER_WS_URL"));
const signer = await createKeyPairSignerFromBytes(new Uint8Array(JSON.parse(await readFile(env("ROUTER_KEYPAIR"), "utf8")) as number[]));
const { url } = await listen(createApp({ router: createRouter({ chain }), chain, signer, staticDir: BUILT_PAGE }), Number(process.env.ROUTER_PORT ?? 8787));
console.log(`Open ${url}\n\nCtrl-C stops the page.`);
