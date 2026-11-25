import { describe, expect, test } from "vitest";
import { type AdviceInput, type MoveCosts, advise, describeAdvice } from "./advice.ts";
import type { RateReading } from "./rates.ts";

const NOW = new Date("2026-11-24T08:00:00.000Z");
const kamino = (ratePercent: number): RateReading => ({ lender: "kamino", ratePercent, source: "k", readAt: NOW });
const jupiter = (ratePercent: number): RateReading => ({ lender: "jupiter", ratePercent, source: "j", readAt: NOW });

// Round numbers so every expected value below can be checked by hand: SOL at $100,
// each fee 5,000 lamports ($0.0005), rent for a new token account 2,000,000 lamports ($0.20).
const costs = (overrides: Partial<MoveCosts> = {}): MoveCosts => ({
  withdrawFeeLamports: 5_000n,
  depositFeeLamports: 5_000n,
  newAccountRentLamports: 2_000_000n,
  solPriceUsd: 100,
  solPriceSource: "test price",
  ...overrides,
});
const at = (usdc: bigint, current: RateReading, other: RateReading, extra: Partial<AdviceInput> = {}): AdviceInput => ({
  position: { lender: current.lender, usdc },
  current,
  other,
  costs: costs(),
  horizonDays: 30,
  ...extra,
});

describe("S1: a position at the lower-rate lender and a gap above the break-even threshold", () => {
  test("recommends moving and gives the days to break even", () => {
    // 10,000 USDC, 2 points more: 10,000 x 0.02 / 365 = $0.547945 a day. Cost $0.201. 0.201 / 0.547945 = 0.3668 days.
    const advice = advise(at(10_000_000_000n, kamino(4), jupiter(6)));
    expect(advice.recommendation).toBe("move");
    expect([advice.from, advice.to]).toEqual(["kamino", "jupiter"]);
    expect(advice.gapPercent).toBeCloseTo(2, 10);
    expect(advice.costUsd).toBeCloseTo(0.201, 10);
    expect(advice.extraPerDayUsd).toBeCloseTo(0.547945, 6);
    expect(advice.breakEvenDays).toBeCloseTo(0.3668, 4);
    expect(advice.reason).toBe("the move pays for itself in under a day, inside the 30-day horizon");
  });

  test("the text leads with the recommendation and shows the days and every number behind them", () => {
    const input = at(1_000_000_000n, kamino(4), jupiter(6));
    // 1,000 USDC, 2 points: $0.054795 a day; 0.201 / 0.054795 = 3.668 days.
    expect(describeAdvice(advise(input), input)).toEqual([
      "Move to Jupiter Lend: the move pays for itself in 3.7 days, inside the 30-day horizon.",
      "  Position        about 1000.000000 USDC at Kamino",
      "  Rates           Kamino 4.000%, Jupiter Lend 6.000% APR (gap +2.000 points)",
      "  Gain            $0.0548 a day more at Jupiter Lend, at today's rates",
      "  Cost of moving  $0.2010: network fees $0.001000, rent for a new Jupiter Lend token account $0.2000",
      "  SOL price       $100.00 (test price)",
      "  Break-even      3.7 days; a gap of 0.245 points would break even in 30 days",
      "  Advice only: nothing was signed or sent. Rates move, so the break-even is today's, not a promise.",
    ]);
  });

  test("it works in either direction", () => {
    expect(advise(at(10_000_000_000n, jupiter(4), kamino(6))).to).toBe("kamino");
  });
});

describe("S2: a gap below the threshold", () => {
  test("recommends staying and shows the numbers behind that", () => {
    // 100 USDC, 0.4 points: 100 x 0.004 / 365 = $0.0010959 a day. 0.201 / 0.0010959 = 183.4 days.
    const input = at(100_000_000n, kamino(4), jupiter(4.4));
    const advice = advise(input);
    expect(advice.recommendation).toBe("stay");
    expect(advice.breakEvenDays).toBeCloseTo(183.41, 1);
    // The gap that would break even in 30 days: 0.201 x 365 x 100 / (100 x 30) = 2.4455 points.
    expect(advice.breakEvenGapPercent).toBeCloseTo(2.4455, 4);
    const lines = describeAdvice(advice, input);
    expect(lines[0]).toBe("Stay with Kamino: the move would take 183 days to pay for itself, longer than the 30-day horizon.");
    expect(lines[6]).toBe("  Break-even      183 days; a gap of 2.446 points would break even in 30 days");
  });

  test("the threshold itself: a move that breaks even exactly at the horizon is recommended, a day later is not", () => {
    const exact = at(100_000_000n, kamino(4), jupiter(4 + 2.4455), { horizonDays: 30.01 });
    expect(advise(exact).recommendation).toBe("move");
    expect(advise({ ...exact, horizonDays: 29 }).recommendation).toBe("stay");
  });

  test("the same gap is worth moving for once the token account exists, because the rent was most of the cost", () => {
    const advice = advise(at(100_000_000n, kamino(4), jupiter(4.4), { costs: costs({ newAccountRentLamports: 0n }) }));
    // Cost is fees only, $0.001; 0.001 / 0.0010959 = 0.91 days.
    expect(advice.recommendation).toBe("move");
    expect(advice.rentUsd).toBe(0);
    expect(advice.breakEvenDays).toBeCloseTo(0.9125, 3);
  });

  test("a longer horizon turns the same numbers into a move", () => {
    expect(advise(at(100_000_000n, kamino(4), jupiter(4.4), { horizonDays: 365 })).recommendation).toBe("move");
  });
});

describe("no gain to be had", () => {
  test("already at the higher lender: stay, and it never breaks even", () => {
    const input = at(10_000_000_000n, jupiter(6), kamino(4));
    const advice = advise(input);
    expect([advice.recommendation, advice.breakEvenDays, advice.gapPercent]).toEqual(["stay", null, -2]);
    expect(advice.reason).toBe("Jupiter Lend already pays more, so a move would cost money and earn none");
    expect(describeAdvice(advice, input)[3]).toBe("  Gain            none");
    expect(describeAdvice(advice, input)[6]).toContain("never, at these rates");
  });

  test("equal rates: stay", () => {
    expect(advise(at(10_000_000_000n, kamino(4), jupiter(4))).reason).toBe("both lenders pay the same, so a move would cost money and earn none");
  });

  test("a position too small to ever pay the rent back within the horizon stays", () => {
    // 1 USDC, 2 points: $0.0000548 a day; 0.201 / 0.0000548 = about 3,668 days.
    const advice = advise(at(1_000_000n, kamino(4), jupiter(6)));
    expect(advice.recommendation).toBe("stay");
    expect(advice.breakEvenDays).toBeGreaterThan(3_600);
  });
});

describe("inputs it will not reason from", () => {
  test.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])("a horizon of %s days is an error", (horizonDays) => {
    expect(() => advise(at(100_000_000n, kamino(4), jupiter(6), { horizonDays }))).toThrow("the horizon must be a positive number of days");
  });

  test.each([0, -70, Number.NaN])("a SOL price of %s is an error, not a free move", (solPriceUsd) => {
    expect(() => advise(at(100_000_000n, kamino(4), jupiter(6), { costs: costs({ solPriceUsd }) }))).toThrow("the SOL price must be a positive number");
  });
});
