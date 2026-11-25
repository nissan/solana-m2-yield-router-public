// Scenarios S2 and S3 on a Surfpool fork of mainnet. Needs a mainnet RPC and
// Jupiter's API, so it is `pnpm run test:fork`, not part of `pnpm run test`.
import type { Address, KeyPairSigner } from "@solana/kit";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { readLedgerInstant, sendInstructions, tokenAccountOf, tokenBalance } from "./chain.ts";
import { JLUSDC_MINT, JUPITER_LEND_API, USDC_MINT } from "./config.ts";
import { type JupiterApi, jupiterApiFromEnv, jupiterDepositInstructions, jupiterWithdrawAllInstructions, readJupiterPosition, readJupiterRate } from "./lenders/jupiter.ts";
import { kaminoDepositInstructions, kaminoSupplyApr, kaminoWithdrawAllInstructions, loadKaminoUsdcReserve, readKaminoPosition, readKaminoRate } from "./lenders/kamino.ts";
import { type RateResult, RouterRefusal, isReading } from "./rates.ts";
import { listen } from "./listen.ts";
import { createRouter } from "./router.ts";
import { createApp } from "./server.ts";
import { type Fork, startFork } from "./testing/fork.ts";

const PRINCIPAL = 100_000_000n; // 100 USDC
const A_DAY = 86_400;
// Both lenders round in their own favour. Seen so far: 1 base unit at Kamino, 2 to 3 at Jupiter Lend.
// Kamino's deposit can also take one base unit less than asked, leaving it in the wallet: it
// deposits only what whole cTokens are worth (its log says "liquidity 999999999999" for 10^12).
const ROUNDING = 5n;
const jupiter: JupiterApi = jupiterApiFromEnv();

let fork: Fork;
beforeAll(() => {
  fork = startFork();
});
afterAll(() => fork.stop());

const usdc = (owner: KeyPairSigner) => tokenBalance(fork.chain, owner.address, USDC_MINT);

async function refusalOf(promise: Promise<unknown>): Promise<RouterRefusal> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof RouterRefusal) return error;
    throw error;
  }
  throw new Error("expected a refusal, and nothing was refused");
}

describe("S2: 100 USDC goes in and comes back out", () => {
  test("Kamino: the position appears after the deposit; a day later the wallet gets at least the principal back", async () => {
    const { signer } = await fork.newWallet(PRINCIPAL);
    await sendInstructions(fork.chain, signer, await kaminoDepositInstructions(fork.chain, signer, PRINCIPAL));
    expect(await usdc(signer)).toBeLessThanOrEqual(ROUNDING); // Kamino can take a base unit less than asked
    const position = await readKaminoPosition(fork.chain, signer.address);
    expect(position.shares).toBeGreaterThan(0n);
    expect(position.usdc).toBeGreaterThanOrEqual(PRINCIPAL - ROUNDING);
    expect(position.usdc).toBeLessThan(PRINCIPAL + 10_000n);

    await fork.advanceSeconds(A_DAY);
    await sendInstructions(fork.chain, signer, await kaminoWithdrawAllInstructions(fork.chain, signer));
    expect(await usdc(signer)).toBeGreaterThanOrEqual(PRINCIPAL);
    expect((await readKaminoPosition(fork.chain, signer.address)).shares).toBe(0n);
  });

  test("Jupiter Lend: the position appears after the deposit; a day later the wallet gets at least the principal back", async () => {
    const { signer } = await fork.newWallet(PRINCIPAL);
    await sendInstructions(fork.chain, signer, await jupiterDepositInstructions(jupiter, signer, PRINCIPAL));
    expect(await usdc(signer)).toBeLessThanOrEqual(ROUNDING); // Kamino can take a base unit less than asked
    const position = await readJupiterPosition(jupiter, fork.chain, signer.address);
    expect(position.shares).toBeGreaterThan(0n);
    expect(position.usdc).toBeGreaterThanOrEqual(PRINCIPAL - ROUNDING);
    expect(position.usdc).toBeLessThan(PRINCIPAL + 10_000n);

    await fork.advanceSeconds(A_DAY);
    await sendInstructions(fork.chain, signer, await jupiterWithdrawAllInstructions(jupiter, fork.chain, signer));
    expect(await usdc(signer)).toBeGreaterThanOrEqual(PRINCIPAL);
    expect((await readJupiterPosition(jupiter, fork.chain, signer.address)).shares).toBe(0n);
  });

  test("the router deposits with whichever lender reads higher, shows that position, and withdraws it in full", async () => {
    const { signer } = await fork.newWallet(PRINCIPAL);
    const router = createRouter({ chain: fork.chain });

    const deposited = await router.deposit(signer, PRINCIPAL);
    const readings = deposited.rates.filter(isReading);
    expect(readings).toHaveLength(2);
    expect(deposited.chosen.ratePercent).toBe(Math.max(...readings.map((r) => r.ratePercent)));
    expect(await usdc(signer)).toBeLessThanOrEqual(ROUNDING); // Kamino can take a base unit less than asked

    const positions = await router.positions(signer.address);
    expect(positions.map((p) => p.lender)).toEqual([deposited.chosen.lender]);

    await fork.advanceSeconds(A_DAY);
    const withdrawn = await router.withdrawAll(signer);
    expect(withdrawn.map((w) => w.lender)).toEqual([deposited.chosen.lender]);
    expect(withdrawn[0]!.usdcReceived).toBeGreaterThanOrEqual(PRINCIPAL);
    expect(await usdc(signer)).toBeGreaterThanOrEqual(PRINCIPAL);
    expect(await router.positions(signer.address)).toEqual([]);
    expect(await router.withdrawAll(signer)).toEqual([]);
  });

  // Found by the first run of the commands: the deposit failed with the lender's
  // LIBRARY_MATH_ERROR, because the fork's clock stood still while mainnet moved on.
  test("a deposit made twenty seconds after the fork started still goes through", async () => {
    const late = startFork();
    try {
      await new Promise((resolve) => setTimeout(resolve, 20_000));
      const { signer } = await late.newWallet(PRINCIPAL);
      await sendInstructions(late.chain, signer, await jupiterDepositInstructions(jupiter, signer, PRINCIPAL));
      expect((await readJupiterPosition(jupiter, late.chain, signer.address)).shares).toBeGreaterThan(0n);
    } finally {
      late.stop();
    }
  });

  // Not what S2 asks, but what a depositor meets: both lenders round in their own favour.
  test.each(["kamino", "jupiter"] as const)("withdrawing from %s in the same minute returns the principal less a few base units of rounding", async (lender) => {
    const { signer } = await fork.newWallet(PRINCIPAL);
    const deposit = lender === "kamino" ? kaminoDepositInstructions(fork.chain, signer, PRINCIPAL) : jupiterDepositInstructions(jupiter, signer, PRINCIPAL);
    await sendInstructions(fork.chain, signer, await deposit);
    const withdraw = lender === "kamino" ? kaminoWithdrawAllInstructions(fork.chain, signer) : jupiterWithdrawAllInstructions(jupiter, fork.chain, signer);
    await sendInstructions(fork.chain, signer, await withdraw);
    const back = await usdc(signer);
    expect(back).toBeGreaterThanOrEqual(PRINCIPAL - ROUNDING);
    expect(back).toBeLessThanOrEqual(PRINCIPAL);
  });
});

describe("S3: a missing or stale rate refuses the deposit and moves nothing", () => {
  async function expectUntouched(signer: KeyPairSigner) {
    expect(await usdc(signer)).toBe(PRINCIPAL);
    expect(await createRouter({ chain: fork.chain }).positions(signer.address)).toEqual([]);
    expect(await fork.chain.rpc.getSignaturesForAddress(signer.address).send()).toEqual([]);
  }

  test("Jupiter's API failing: refused, naming Jupiter Lend", async () => {
    const { signer } = await fork.newWallet(PRINCIPAL);
    const down: JupiterApi = { baseUrl: JUPITER_LEND_API, fetch: async () => new Response("unavailable", { status: 503 }) };
    const error = await refusalOf(createRouter({ chain: fork.chain, jupiter: down }).deposit(signer, PRINCIPAL));
    expect([error.code, error.lender]).toEqual(["RATE_MISSING", "jupiter"]);
    expect(error.message).toContain("HTTP 503");
    await expectUntouched(signer);
  });

  test("the RPC failing for Kamino: refused, naming Kamino", async () => {
    const { signer } = await fork.newWallet(PRINCIPAL);
    const deadRpc = { ...fork.chain, rpc: new Proxy(fork.chain.rpc, { get: () => () => ({ send: () => Promise.reject(new Error("RPC unreachable")) }) }) };
    const error = await refusalOf(createRouter({ chain: deadRpc }).deposit(signer, PRINCIPAL));
    expect([error.code, error.lender]).toEqual(["RATE_MISSING", "kamino"]);
    await expectUntouched(signer);
  });

  test("rates read more than the freshness limit ago: refused as stale", async () => {
    const { signer } = await fork.newWallet(PRINCIPAL);
    let clock = Date.now();
    const router = createRouter({ chain: fork.chain, now: () => new Date(clock) });
    const rates: RateResult[] = await router.readRates();
    expect(rates.every(isReading)).toBe(true);
    clock += router.freshnessLimitMs + 1_000;
    const error = await refusalOf(router.deposit(signer, PRINCIPAL, rates));
    expect(error.code).toBe("RATE_STALE");
    await expectUntouched(signer);
  });

  test("more USDC than the wallet holds: refused before anything is built", async () => {
    const { signer } = await fork.newWallet(PRINCIPAL);
    const error = await refusalOf(createRouter({ chain: fork.chain }).deposit(signer, PRINCIPAL + 1n));
    expect(error.code).toBe("INSUFFICIENT_USDC");
    await expectUntouched(signer);
  });
});

describe("M2-005: the same through the page's server", () => {
  test("S2: rates, deposit, position, a day, withdraw, all over HTTP; S3: stale shown rates are refused and move nothing", async () => {
    const { signer } = await fork.newWallet(PRINCIPAL);
    let skewMs = 0;
    const router = createRouter({ chain: fork.chain, now: () => new Date(Date.now() + skewMs) });
    const { server, url } = await listen(createApp({ router, chain: fork.chain, signer, advanceSeconds: fork.advanceSeconds }), 0);
    const get = async (path: string) => (await fetch(url + path)).json() as Promise<Record<string, never>>;
    const post = (path: string, body: unknown) => fetch(url + path, { method: "POST", headers: { "content-type": "application/json", origin: url }, body: JSON.stringify(body) });
    try {
      // S3 first, while the wallet is untouched: the page shows rates, then sits for longer than the limit.
      const old = await get("/api/rates");
      skewMs = router.freshnessLimitMs + 1_000;
      const refused = await post("/api/deposit", { amount: "100", ratesId: old.id });
      expect(refused.status).toBe(409);
      expect(((await refused.json()) as { refusal: { code: string } }).refusal.code).toBe("RATE_STALE");
      expect(await usdc(signer)).toBe(PRINCIPAL);
      expect(await fork.chain.rpc.getSignaturesForAddress(signer.address).send()).toEqual([]);
      skewMs = 0;

      const rates = await get("/api/rates");
      expect(rates.higher).not.toBeNull();
      const deposited = await post("/api/deposit", { amount: "100", ratesId: rates.id });
      expect(deposited.status).toBe(200);
      expect(((await deposited.json()) as { lender: string }).lender).toBe(rates.higher);

      const position = (await get("/api/position")) as unknown as { usdc: string; positions: { lender: string; usdc: string }[] };
      expect(BigInt(position.usdc)).toBeLessThanOrEqual(ROUNDING);
      expect(position.positions.map((p) => p.lender)).toEqual([rates.higher]);
      expect(BigInt(position.positions[0]!.usdc)).toBeGreaterThanOrEqual(PRINCIPAL - ROUNDING);

      expect((await post("/api/fork/advance-day", {})).status).toBe(200);
      const withdrawn = (await (await post("/api/withdraw", {})).json()) as { withdrawals: { usdcReceived: string }[] };
      expect(BigInt(withdrawn.withdrawals[0]!.usdcReceived)).toBeGreaterThanOrEqual(PRINCIPAL);
      const after = (await get("/api/position")) as unknown as { usdc: string; positions: unknown[] };
      expect(BigInt(after.usdc)).toBeGreaterThanOrEqual(PRINCIPAL);
      expect(after.positions).toEqual([]);
    } finally {
      server.close();
      server.closeAllConnections();
    }
  });
});

describe("M2-004: is moving worth its cost?", () => {
  // Puts `amount` with whichever lender reads lower right now, so there is a higher one to consider moving to.
  async function positionAtLowerLender(amount: bigint) {
    const { signer } = await fork.newWallet(amount);
    const router = createRouter({ chain: fork.chain });
    const readings = (await router.readRates()).filter(isReading);
    const lower = readings.reduce((a, b) => (b.ratePercent < a.ratePercent ? b : a));
    const deposit = lower.lender === "kamino" ? kaminoDepositInstructions(fork.chain, signer, amount) : jupiterDepositInstructions(jupiter, signer, amount);
    await sendInstructions(fork.chain, signer, await deposit);
    return { signer, router, lower: lower.lender };
  }

  test("the costs are read from the chain, the advice follows from them, and nothing is sent", async () => {
    const { signer, router, lower } = await positionAtLowerLender(PRINCIPAL);
    const sentBefore = (await fork.chain.rpc.getSignaturesForAddress(signer.address).send()).length;
    const sol = await fork.chain.rpc.getBalance(signer.address).send();

    const [result, ...rest] = await router.recommend(signer.address, 30);
    expect(rest).toEqual([]);
    const { advice, input } = result!;
    expect(advice.from).toBe(lower);
    expect(advice.gapPercent).toBeGreaterThan(0);
    expect(input.position.usdc).toBeGreaterThanOrEqual(PRINCIPAL - ROUNDING);

    // Each fee is at least one signature's worth and nowhere near a cent of SOL.
    for (const fee of [input.costs.withdrawFeeLamports, input.costs.depositFeeLamports]) {
      expect(fee).toBeGreaterThanOrEqual(5_000n);
      expect(fee).toBeLessThan(1_000_000n);
    }
    // The wallet has never held the other lender's token, so a move pays rent for that account.
    expect(input.costs.newAccountRentLamports).toBe(await fork.chain.rpc.getMinimumBalanceForRentExemption(165n).send());
    expect(input.costs.solPriceUsd).toBeGreaterThan(1);
    expect(input.costs.solPriceUsd).toBeLessThan(100_000);

    expect(advice.breakEvenDays).not.toBeNull();
    expect(advice.recommendation).toBe(advice.breakEvenDays! <= 30 ? "move" : "stay");

    expect((await fork.chain.rpc.getSignaturesForAddress(signer.address).send()).length).toBe(sentBefore);
    expect((await fork.chain.rpc.getBalance(signer.address).send()).value).toBe(sol.value);
    expect((await router.positions(signer.address)).map((p) => p.lender)).toEqual([lower]);
  });

  test("S1: a million USDC at the lower lender is told to move, with the days to break even", async () => {
    const { signer, router } = await positionAtLowerLender(1_000_000_000_000n);
    const [result] = await router.recommend(signer.address, 30);
    expect(result!.advice.recommendation).toBe("move");
    expect(result!.advice.breakEvenDays).toBeLessThan(1);
  });

  test("S2: one USDC at the lower lender is told to stay, with the numbers", async () => {
    const { signer, router } = await positionAtLowerLender(1_000_000n);
    const [result] = await router.recommend(signer.address, 30);
    expect(result!.advice.recommendation).toBe("stay");
    expect(result!.advice.breakEvenDays).toBeGreaterThan(30);
    expect(result!.advice.costUsd).toBeGreaterThan(0);
  });

  test("with no position there is nothing to advise on; with stale rates the advice is refused", async () => {
    const { signer } = await fork.newWallet(PRINCIPAL);
    expect(await createRouter({ chain: fork.chain }).recommend(signer.address)).toEqual([]);
    let clock = Date.now();
    const lagging = createRouter({ chain: fork.chain, now: () => new Date((clock += 61_000)) });
    expect((await refusalOf(lagging.recommend(signer.address))).code).toBe("RATE_STALE");
  });
});

describe("M2-006: an answer from Jupiter's API that sends the tokens elsewhere is refused", () => {
  /** Jupiter's real API, with every instruction answer re-pointed so the tokens arrive in `thief`'s account. */
  async function redirectingApi(thief: Address): Promise<JupiterApi> {
    const real = jupiterApiFromEnv();
    return {
      ...real,
      fetch: async (input, init) => {
        const response = await real.fetch(input, init);
        const url = String(input);
        if (!url.endsWith("-instructions") || !response.ok) return response;
        const body = (await response.json()) as { instructions: { accounts: { pubkey: string }[] }[] };
        const mint = url.endsWith("/earn/deposit-instructions") ? JLUSDC_MINT : USDC_MINT;
        body.instructions[0]!.accounts[2]!.pubkey = await tokenAccountOf(thief, mint);
        return Response.json(body);
      },
    };
  }

  test("S2, deposit: refused before signing, naming the account; the wallet is untouched", async () => {
    const { signer } = await fork.newWallet(PRINCIPAL);
    const thief = (await fork.newWallet(0n)).signer.address;
    const api = await redirectingApi(thief);
    const router = createRouter({ chain: fork.chain, jupiter: api });
    // Jupiter Lend so that the answer is Jupiter's, whichever lender reads higher today.
    const error = await refusalOf(jupiterDepositInstructions(api, signer, PRINCIPAL));
    expect(error.code).toBe("UNEXPECTED_INSTRUCTIONS");
    expect(error.message).toContain(await tokenAccountOf(thief, JLUSDC_MINT));
    expect(await usdc(signer)).toBe(PRINCIPAL);
    expect(await fork.chain.rpc.getSignaturesForAddress(signer.address).send()).toEqual([]);
    expect(await router.positions(signer.address)).toEqual([]);
  });

  test("S2, withdraw: refused before signing; the position stays where it was", async () => {
    const { signer } = await fork.newWallet(PRINCIPAL);
    await sendInstructions(fork.chain, signer, await jupiterDepositInstructions(jupiter, signer, PRINCIPAL));
    const sentBefore = (await fork.chain.rpc.getSignaturesForAddress(signer.address).send()).length;
    const thief = (await fork.newWallet(0n)).signer.address;
    const router = createRouter({ chain: fork.chain, jupiter: await redirectingApi(thief) });
    const error = await refusalOf(router.withdrawAll(signer));
    expect(error.code).toBe("UNEXPECTED_INSTRUCTIONS");
    expect(error.message).toContain(await tokenAccountOf(thief, USDC_MINT));
    expect((await fork.chain.rpc.getSignaturesForAddress(signer.address).send()).length).toBe(sentBefore);
    expect((await readJupiterPosition(jupiter, fork.chain, signer.address)).shares).toBeGreaterThan(0n);
    expect(await tokenBalance(fork.chain, thief, USDC_MINT)).toBe(0n);
  });
});

describe("M2-007: both rates are simple yearly rates, and that is what a deposit earns", () => {
  test("S3: Kamino's rate is its supply APR plus its rewards APR, not the compounded APY", async () => {
    const { reserve, instant } = await loadKaminoUsdcReserve(fork.chain);
    const apr = kaminoSupplyApr(reserve, instant);
    const reading = await readKaminoRate(fork.chain, () => new Date());
    expect(reading.ratePercent).toBeCloseTo(apr.total * 100, 6);
    expect(reading.ratePercent).not.toBeCloseTo(reserve.totalSupplyAPY(instant) * 100, 3);
    expect(reading.source).toMatch(/supply APR [\d.]+% \+ reserve rewards APR [\d.]+%/);
  });

  // A million USDC each, so the lenders' rounding is too small to matter; a day on the fork's clock.
  test("S2: a day's growth at each lender matches its rate (Kamino within 1%, Jupiter Lend within 2%)", async () => {
    const P = 1_000_000_000_000n;
    const k = (await fork.newWallet(P)).signer;
    const u = (await fork.newWallet(P)).signer;
    await sendInstructions(fork.chain, k, await kaminoDepositInstructions(fork.chain, k, P));
    await sendInstructions(fork.chain, u, await jupiterDepositInstructions(jupiter, u, P));
    const kaminoRate = (await readKaminoRate(fork.chain, () => new Date())).ratePercent;
    const jupiterRate = (await readJupiterRate(jupiter, () => new Date())).ratePercent;
    const t0 = await readLedgerInstant(fork.chain);
    const k0 = (await readKaminoPosition(fork.chain, k.address)).usdc;
    const j0 = (await readJupiterPosition(jupiter, fork.chain, u.address)).usdc;
    await fork.advanceSeconds(A_DAY);
    const t1 = await readLedgerInstant(fork.chain);
    const k1 = (await readKaminoPosition(fork.chain, k.address)).usdc;
    const j1 = (await readJupiterPosition(jupiter, fork.chain, u.address)).usdc;
    const yearly = (a: bigint, b: bigint) => (Number(b - a) / Number(a)) * ((365 * 86_400) / Number(t1.blockTime - t0.blockTime)) * 100;
    const kaminoEarned = yearly(k0, k1);
    const jupiterEarned = yearly(j0, j1);
    console.log(`Kamino: rate ${kaminoRate.toFixed(4)}%, earned at ${kaminoEarned.toFixed(4)}% a year. Jupiter Lend: rate ${jupiterRate.toFixed(4)}%, earned at ${jupiterEarned.toFixed(4)}% a year.`);
    expect(Math.abs(kaminoEarned / kaminoRate - 1)).toBeLessThan(0.01);
    expect(Math.abs(jupiterEarned / jupiterRate - 1)).toBeLessThan(0.02);
  });
});
