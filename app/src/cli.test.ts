import { generateKeyPairSigner } from "@solana/kit";
import { Surfnet } from "@solana/surfpool";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { connect } from "./chain.ts";
import { USAGE, run } from "./cli.ts";
import type { JupiterApi } from "./lenders/jupiter.ts";
import { type AdviceInput, advise } from "./advice.ts";
import { type RateReading, type RateResult, RouterRefusal } from "./rates.ts";
import { type Router, createRouter } from "./router.ts";

const NOW = new Date("2026-11-24T08:00:00.000Z");
const rates: RateResult[] = [
  { lender: "kamino", ratePercent: 3.976, source: "Kamino reserve D6q6 (slot 1)", readAt: NOW },
  { lender: "jupiter", ratePercent: 4.4, source: "https://jup.example/earn/tokens", readAt: NOW },
];

// An offline runtime stands in for the fork: real RPC, no lenders on it.
let surfnet: Surfnet;
beforeAll(() => {
  surfnet = Surfnet.start();
});
afterAll(() => surfnet.stop());

async function harness(overrides: Partial<Router> = {}) {
  const chain = connect(surfnet.rpcUrl, surfnet.wsUrl);
  const signer = await generateKeyPairSigner();
  const lines: string[] = [];
  const calls: string[] = [];
  const router: Router = {
    readRates: async () => rates,
    deposit: async (_owner, amount, used) => {
      calls.push(`deposit ${amount}`);
      return { chosen: rates[1] as never, rates: used ?? rates, amount, signature: "SIG" };
    },
    positions: async () => [],
    withdrawAll: async () => [],
    recommend: async () => [],
    now: () => NOW,
    freshnessLimitMs: 60_000,
    ...overrides,
  };
  return { lines, calls, exit: (argv: string[]) => run(argv, router, chain, { out: (line) => lines.push(line), signer: async () => signer }) };
}

describe("S1: compare", () => {
  test("prints each rate with its source and read time and names the higher one", async () => {
    const h = await harness();
    expect(await h.exit(["compare"])).toBe(0);
    expect(h.lines).toEqual([
      "Kamino        3.976% APR  read 2026-11-24T08:00:00.000Z  source Kamino reserve D6q6 (slot 1)",
      "Jupiter Lend  4.400% APR  read 2026-11-24T08:00:00.000Z  source https://jup.example/earn/tokens",
      "Higher: Jupiter Lend at 4.400% APR",
    ]);
  });

  test("needs no wallet", async () => {
    const h = await harness();
    const exit = await run(["compare"], { readRates: async () => rates, now: () => NOW, freshnessLimitMs: 60_000 } as Router, connect(surfnet.rpcUrl, surfnet.wsUrl), {
      out: (line) => h.lines.push(line),
      signer: async () => {
        throw new Error("compare asked for the wallet");
      },
    });
    expect(exit).toBe(0);
  });
});

describe("deposit", () => {
  test("shows the comparison, then says where the money went", async () => {
    const h = await harness();
    expect(await h.exit(["deposit", "100"])).toBe(0);
    expect(h.calls).toEqual(["deposit 100000000"]);
    expect(h.lines.at(-1)).toBe("Deposited 100.000000 USDC with Jupiter Lend: SIG");
  });

  test("S3: a refusal is printed with its reason, exits 1 and says nothing was sent", async () => {
    const h = await harness({
      deposit: async () => {
        throw new RouterRefusal("RATE_STALE", "Kamino's rate is stale: read 61s ago, the limit is 60s", "kamino");
      },
    });
    expect(await h.exit(["deposit", "100"])).toBe(1);
    expect(h.lines.at(-1)).toBe("Refused (RATE_STALE): Kamino's rate is stale: read 61s ago, the limit is 60s. Nothing was sent.");
  });

  test.each([["deposit"], ["deposit", "1", "2"], ["rebalance"], []])("%j prints the usage and exits 2 without touching the router", async (...argv) => {
    const h = await harness();
    expect(await h.exit(argv)).toBe(2);
    expect(h.lines).toEqual([USAGE]);
    expect(h.calls).toEqual([]);
  });

  test("a bad amount is refused before any rate is read", async () => {
    let read = false;
    const h = await harness({
      readRates: async () => {
        read = true;
        return rates;
      },
    });
    expect(await h.exit(["deposit", "ten"])).toBe(1);
    expect(h.lines).toEqual(['Refused (BAD_AMOUNT): "ten" is not a USDC amount (digits, at most six decimals). Nothing was sent.']);
    expect(read).toBe(false);
  });
});

describe("the real router, with a lender that cannot be read", () => {
  test("S3: deposit refuses with RATE_MISSING and sends nothing", async () => {
    const chain = connect(surfnet.rpcUrl, surfnet.wsUrl);
    const signer = await generateKeyPairSigner();
    const down: JupiterApi = { baseUrl: "https://jup.example/lend/v1", fetch: async () => new Response("down", { status: 503 }) };
    const lines: string[] = [];
    // Offline, Kamino's market does not exist either; the refusal names the first lender that could not be read.
    const exit = await run(["deposit", "100"], createRouter({ chain, jupiter: down }), chain, { out: (l) => lines.push(l), signer: async () => signer });
    expect(exit).toBe(1);
    expect(lines.at(-1)).toMatch(/^Refused \(RATE_MISSING\): Kamino's rate could not be read: .+\. Nothing was sent\.$/);
    expect(lines[1]).toBe("Jupiter Lend  not read: https://jup.example/lend/v1/earn/tokens answered HTTP 503");
    expect(await chain.rpc.getSignaturesForAddress(signer.address).send()).toEqual([]);
  });
});

describe("position and withdraw", () => {
  test("position with nothing deposited says so", async () => {
    const h = await harness();
    expect(await h.exit(["position"])).toBe(0);
    expect(h.lines[0]).toMatch(/^Wallet \w+ holds 0\.000000 USDC$/);
    expect(h.lines[1]).toBe("No position at either lender");
  });

  test("position lists what is held where", async () => {
    const h = await harness({ positions: async () => [{ lender: "kamino", shares: 82_532_570n, usdc: 99_999_999n }] });
    await h.exit(["position"]);
    expect(h.lines[1]).toBe("Kamino: about 99.999999 USDC (82532570 shares)");
  });

  test("withdraw reports what came back from where", async () => {
    const h = await harness({ withdrawAll: async () => [{ lender: "jupiter", signature: "SIG2", usdcReceived: 100_012_345n }] });
    expect(await h.exit(["withdraw"])).toBe(0);
    expect(h.lines[0]).toBe("Withdrew 100.012345 USDC from Jupiter Lend: SIG2");
  });

  test("withdraw with no position says so", async () => {
    const h = await harness();
    await h.exit(["withdraw"]);
    expect(h.lines[0]).toBe("Nothing to withdraw");
  });
});

describe("M2-004: recommend", () => {
  const input: AdviceInput = {
    position: { lender: "kamino", usdc: 1_000_000_000n },
    current: rates[0] as RateReading,
    other: { ...(rates[1] as RateReading), ratePercent: 6 },
    horizonDays: 30,
    costs: { withdrawFeeLamports: 5_000n, depositFeeLamports: 5_000n, newAccountRentLamports: 2_000_000n, solPriceUsd: 100, solPriceSource: "test price" },
  };

  test("prints the recommendation first, then the numbers, for the horizon asked for; exits 0", async () => {
    const asked: number[] = [];
    const h = await harness({
      recommend: async (_owner, horizonDays) => {
        asked.push(horizonDays!);
        const withHorizon = { ...input, horizonDays: horizonDays! };
        return [{ input: withHorizon, advice: advise(withHorizon) }];
      },
    });
    expect(await h.exit(["recommend", "7"])).toBe(0);
    expect(asked).toEqual([7]);
    expect(h.lines[0]).toBe("Move to Jupiter Lend: the move pays for itself in 3.6 days, inside the 7-day horizon.");
    expect(h.lines).toHaveLength(8);
    expect(h.lines.at(-1)).toContain("nothing was signed or sent");
    expect(h.calls).toEqual([]);
  });

  test("without a number of days it uses 30", async () => {
    const asked: (number | undefined)[] = [];
    const h = await harness({ recommend: async (_owner, horizonDays) => (asked.push(horizonDays), []) });
    await h.exit(["recommend"]);
    expect(asked).toEqual([30]);
  });

  test("with no position it says there is nothing to move", async () => {
    const h = await harness();
    expect(await h.exit(["recommend"])).toBe(0);
    expect(h.lines).toEqual(["No position at either lender, so there is nothing to move. Nothing was signed or sent."]);
  });

  test.each(["0", "-3", "soon"])('a horizon of "%s" is refused before anything is read', async (days) => {
    let asked = false;
    const h = await harness({ recommend: async () => ((asked = true), []) });
    expect(await h.exit(["recommend", days])).toBe(1);
    expect(h.lines).toEqual([`Refused (BAD_HORIZON): "${days}" is not a positive number of days. Nothing was sent.`]);
    expect(asked).toBe(false);
  });

  test("a missing or stale rate refuses the advice too", async () => {
    const h = await harness({
      recommend: async () => {
        throw new RouterRefusal("RATE_MISSING", "Jupiter Lend's rate could not be read: HTTP 503", "jupiter");
      },
    });
    expect(await h.exit(["recommend"])).toBe(1);
    expect(h.lines).toEqual(["Refused (RATE_MISSING): Jupiter Lend's rate could not be read: HTTP 503. Nothing was sent."]);
  });
});
