// The whole thing, once, with nothing to set up: starts a fork of mainnet,
// makes a test wallet with 100 USDC, and runs the router's scenarios against
// the real lenders' programs, checking each result as it goes. Exits 0 only
// if every check held. Nothing here can reach mainnet: every transaction
// lands on the fork, and the wallet exists nowhere else.
//
//   pnpm run reproduce
//
// MAINNET_RPC_URL and JUPITER_API_KEY are optional; without them the public
// endpoints are used, which rate-limit, and the run takes about half a minute longer.
import { describeAdvice } from "../src/advice.ts";
import { tokenBalance } from "../src/chain.ts";
import { USDC_MINT } from "../src/config.ts";
import { LENDER_NAMES, RouterRefusal, describeComparison, formatUsdc, isReading } from "../src/rates.ts";
import { createRouter } from "../src/router.ts";
import { startFork } from "../src/testing/fork.ts";

const PRINCIPAL = 100_000_000n;
let failed = 0;
function check(what: string, ok: boolean): void {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${what}`);
  if (!ok) failed += 1;
}
const step = (title: string) => console.log(`\n${title}`);

const fork = startFork();
try {
  const { signer } = await fork.newWallet(PRINCIPAL);
  const usdc = () => tokenBalance(fork.chain, signer.address, USDC_MINT);
  const sent = async () => (await fork.chain.rpc.getSignaturesForAddress(signer.address).send()).length;
  console.log(`Fork of mainnet at ${fork.chain.rpcUrl}. Test wallet ${signer.address}: 100 USDC, on this fork only.`);
  console.log("Signatures below are from the fork; no block explorer knows them.");

  // A clock the script can push forward, to show what happens to rates left unread.
  let lateBy = 0;
  const router = createRouter({ chain: fork.chain, now: () => new Date(Date.now() + lateBy) });

  step("1. Compare (M2-002-S1): both rates, each with its source and read time, and the higher one");
  const rates = await router.readRates();
  for (const line of describeComparison(rates, router.now(), router.freshnessLimitMs)) console.log(`  ${line}`);
  const readings = rates.filter(isReading);
  check("both rates were read", readings.length === 2);
  const higher = readings.reduce((a, b) => (b.ratePercent > a.ratePercent ? b : a));

  step("2. Refusal (M2-002-S3): the same rates, 61 seconds later, are too old to act on");
  lateBy = router.freshnessLimitMs + 1_000;
  let refusal: RouterRefusal | undefined;
  try {
    await router.deposit(signer, PRINCIPAL, rates);
  } catch (error) {
    if (!(error instanceof RouterRefusal)) throw error;
    refusal = error;
  }
  lateBy = 0;
  console.log(`  ${refusal ? `Refused (${refusal.code}): ${refusal.message}` : "The deposit was not refused"}`);
  check("the deposit was refused as stale, naming the lender", refusal?.code === "RATE_STALE" && refusal.lender !== undefined);
  check("the wallet still holds 100 USDC and has sent no transaction", (await usdc()) === PRINCIPAL && (await sent()) === 0);

  step("3. Deposit (M2-002-S2): 100 USDC goes to the lender that reads higher");
  const deposited = await router.deposit(signer, PRINCIPAL);
  console.log(`  Deposited ${formatUsdc(deposited.amount)} USDC with ${LENDER_NAMES[deposited.chosen.lender]}: ${deposited.signature}`);
  const positions = await router.positions(signer.address);
  for (const p of positions) console.log(`  Position: about ${formatUsdc(p.usdc)} USDC at ${LENDER_NAMES[p.lender]} (${p.shares} of its tokens in the wallet)`);
  check(`it went to ${LENDER_NAMES[higher.lender]}, the higher rate read in step 1`, deposited.chosen.lender === higher.lender);
  // A lender may take a base unit less than asked and leave it in the wallet.
  check("the wallet's USDC is now 0, give or take 5 base units, and the position is at that lender only", (await usdc()) <= 5n && positions.length === 1 && positions[0]!.lender === higher.lender);
  check("the position is worth the principal, less at most 5 base units of the lender's rounding", positions[0] !== undefined && positions[0].usdc >= PRINCIPAL - 5n);

  step("4. Advice (M2-004): is it worth moving to the other lender? Nothing is sent");
  const before = await sent();
  for (const { advice, input } of await router.recommend(signer.address)) for (const line of describeAdvice(advice, input)) console.log(`  ${line}`);
  check("the advice sent no transaction", (await sent()) === before);

  step("5. Withdraw (M2-002-S2): one day later on the fork's clock, everything comes back");
  await fork.advanceSeconds(86_400);
  const withdrawn = await router.withdrawAll(signer);
  for (const w of withdrawn) console.log(`  Withdrew ${formatUsdc(w.usdcReceived)} USDC from ${LENDER_NAMES[w.lender]}: ${w.signature}`);
  const back = await usdc();
  console.log(`  Wallet holds ${formatUsdc(back)} USDC`);
  check("the wallet holds at least the 100 USDC it started with", back >= PRINCIPAL);
  check("no position is left at either lender", (await router.positions(signer.address)).length === 0);

  console.log(failed === 0 ? "\nEvery check held." : `\n${failed} check(s) FAILED.`);
} finally {
  fork.stop();
}
process.exitCode = failed === 0 ? 0 : 1;
