#!/usr/bin/env node
// The commands: compare, deposit <usdc>, position, withdraw, recommend [days].
import { readFile } from "node:fs/promises";
import { type KeyPairSigner, createKeyPairSignerFromBytes } from "@solana/kit";
import { DEFAULT_HORIZON_DAYS, describeAdvice } from "./advice.ts";
import { connect, tokenBalance } from "./chain.ts";
import { USDC_MINT } from "./config.ts";
import { LENDER_NAMES, RouterRefusal, describeComparison, formatUsdc, parseUsdc } from "./rates.ts";
import { type Router, createRouter } from "./router.ts";

export const USAGE = `Usage: router <command>

  compare            read both lenders' USDC supply rates and name the higher
  deposit <usdc>     deposit that much USDC with the lender that pays more
  position           show what the wallet holds at each lender
  withdraw           withdraw everything
  recommend [days]   say whether moving to the other lender is worth its cost within that
                     many days (30 unless given); advice only, nothing is sent

Environment:
  ROUTER_RPC_URL     the fork's HTTP address (printed by "pnpm run fork")
  ROUTER_WS_URL      the fork's WebSocket address
  ROUTER_KEYPAIR     path to the test wallet's keypair file; not needed by compare
  JUPITER_API_KEY    optional; without it Jupiter's keyless host is used (5 requests in 10 seconds)`;

export type Io = { out: (line: string) => void; signer: () => Promise<KeyPairSigner> };

/** Runs one command against a router. Returns the process exit code: 0 done, 1 refused, 2 usage. (3, set below, is a failure.) */
export async function run(argv: readonly string[], router: Router, chain: Parameters<typeof tokenBalance>[0], io: Io): Promise<number> {
  const [command, ...rest] = argv;
  try {
    switch (command) {
      case "compare": {
        const rates = await router.readRates();
        for (const line of describeComparison(rates, router.now(), router.freshnessLimitMs)) io.out(line);
        return 0;
      }
      case "deposit": {
        if (rest.length !== 1) break;
        const amount = parseUsdc(rest[0]!);
        const rates = await router.readRates();
        for (const line of describeComparison(rates, router.now(), router.freshnessLimitMs)) io.out(line);
        const result = await router.deposit(await io.signer(), amount, rates);
        io.out(`Deposited ${formatUsdc(result.amount)} USDC with ${LENDER_NAMES[result.chosen.lender]}: ${result.signature}`);
        return 0;
      }
      case "position": {
        const owner = (await io.signer()).address;
        const positions = await router.positions(owner);
        io.out(`Wallet ${owner} holds ${formatUsdc(await tokenBalance(chain, owner, USDC_MINT))} USDC`);
        if (positions.length === 0) io.out("No position at either lender");
        for (const p of positions) io.out(`${LENDER_NAMES[p.lender]}: about ${formatUsdc(p.usdc)} USDC (${p.shares} shares)`);
        return 0;
      }
      case "recommend": {
        if (rest.length > 1) break;
        const horizonDays = rest[0] === undefined ? DEFAULT_HORIZON_DAYS : Number(rest[0]);
        if (!Number.isFinite(horizonDays) || horizonDays <= 0) throw new RouterRefusal("BAD_HORIZON", `"${rest[0]}" is not a positive number of days`);
        const results = await router.recommend((await io.signer()).address, horizonDays);
        if (results.length === 0) io.out("No position at either lender, so there is nothing to move. Nothing was signed or sent.");
        for (const { advice, input } of results) for (const line of describeAdvice(advice, input)) io.out(line);
        return 0;
      }
      case "withdraw": {
        const signer = await io.signer();
        const results = await router.withdrawAll(signer);
        if (results.length === 0) io.out("Nothing to withdraw");
        for (const r of results) io.out(`Withdrew ${formatUsdc(r.usdcReceived)} USDC from ${LENDER_NAMES[r.lender]}: ${r.signature}`);
        io.out(`Wallet ${signer.address} holds ${formatUsdc(await tokenBalance(chain, signer.address, USDC_MINT))} USDC`);
        return 0;
      }
    }
  } catch (error) {
    if (!(error instanceof RouterRefusal)) throw error;
    io.out(`Refused (${error.code}): ${error.message}. Nothing was sent.`);
    return 1;
  }
  io.out(USAGE);
  return 2;
}

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set.\n\n${USAGE}`);
  return value;
}

if (import.meta.main) {
  try {
    const chain = connect(env("ROUTER_RPC_URL"), env("ROUTER_WS_URL"));
    const signer = async () => createKeyPairSignerFromBytes(new Uint8Array(JSON.parse(await readFile(env("ROUTER_KEYPAIR"), "utf8")) as number[]));
    process.exitCode = await run(process.argv.slice(2), createRouter({ chain }), chain, { out: (line) => console.log(line), signer });
  } catch (error) {
    // Not a refusal: something was attempted and failed, or the setup is wrong. Say what, without a stack.
    console.error(`Failed: ${error instanceof Error ? error.message : String(error)}`);
    const logs = (error as { context?: { logs?: unknown } }).context?.logs;
    if (Array.isArray(logs)) for (const line of logs.slice(-6)) console.error(`  ${line}`);
    process.exitCode = 3;
  }
}
