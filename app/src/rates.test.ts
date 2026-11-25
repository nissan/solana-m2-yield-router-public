import { describe, expect, test } from "vitest";
import { type RateResult, RouterRefusal, chooseLender, describeComparison, formatUsdc, parseUsdc } from "./rates.ts";

const NOW = new Date("2026-11-24T08:00:00.000Z");
const LIMIT = 60_000;
const secondsAgo = (s: number) => new Date(NOW.getTime() - s * 1000);
const kamino = (ratePercent: number, age = 1): RateResult => ({ lender: "kamino", ratePercent, source: "Kamino reserve D6q6 (slot 1)", readAt: secondsAgo(age) });
const jupiter = (ratePercent: number, age = 1): RateResult => ({ lender: "jupiter", ratePercent, source: "https://jup.example/earn/tokens", readAt: secondsAgo(age) });

function refusal(run: () => unknown): RouterRefusal {
  try {
    run();
  } catch (error) {
    if (error instanceof RouterRefusal) return error;
    throw error;
  }
  throw new Error("expected a refusal, and nothing was refused");
}

describe("choosing a lender", () => {
  test("the higher rate wins, whichever lender it is", () => {
    expect(chooseLender([kamino(3.9), jupiter(4.4)], NOW, LIMIT).lender).toBe("jupiter");
    expect(chooseLender([kamino(5.1), jupiter(4.4)], NOW, LIMIT).lender).toBe("kamino");
    expect(chooseLender([jupiter(4.4), kamino(5.1)], NOW, LIMIT).lender).toBe("kamino");
  });

  test("an exact tie goes to Kamino", () => {
    expect(chooseLender([jupiter(4), kamino(4)], NOW, LIMIT).lender).toBe("kamino");
  });

  test("a rate that could not be read is a refusal that names the lender and the reason", () => {
    const error = refusal(() => chooseLender([kamino(3.9), { lender: "jupiter", error: "HTTP 503" }], NOW, LIMIT));
    expect(error.code).toBe("RATE_MISSING");
    expect(error.lender).toBe("jupiter");
    expect(error.message).toBe("Jupiter Lend's rate could not be read: HTTP 503");
  });

  test("a lender with no result at all is missing, not skipped", () => {
    const error = refusal(() => chooseLender([jupiter(4.4)], NOW, LIMIT));
    expect([error.code, error.lender]).toEqual(["RATE_MISSING", "kamino"]);
  });

  test("a rate older than the limit is a refusal that names the lender and its age", () => {
    const error = refusal(() => chooseLender([kamino(3.9, 61), jupiter(4.4)], NOW, LIMIT));
    expect(error.code).toBe("RATE_STALE");
    expect(error.lender).toBe("kamino");
    expect(error.message).toBe("Kamino's rate is stale: read 61s ago, the limit is 60s");
  });

  test("an age a moment past the limit is not printed as equal to the limit", () => {
    const justPast: RateResult = { lender: "kamino", ratePercent: 3.9, source: "s", readAt: new Date(NOW.getTime() - 60_400) };
    expect(refusal(() => chooseLender([justPast, jupiter(4.4)], NOW, LIMIT)).message).toBe("Kamino's rate is stale: read 61s ago, the limit is 60s");
  });

  test("a rate exactly at the limit is still fresh", () => {
    expect(chooseLender([kamino(3.9, 60), jupiter(4.4, 60)], NOW, LIMIT).lender).toBe("jupiter");
  });

  test("the stale higher rate is not passed over for the fresh lower one", () => {
    expect(refusal(() => chooseLender([kamino(3.9), jupiter(9.9, 600)], NOW, LIMIT)).lender).toBe("jupiter");
  });

  test.each([Number.NaN, Number.POSITIVE_INFINITY, -1])("a rate of %s is not usable", (rate) => {
    expect(refusal(() => chooseLender([kamino(rate), jupiter(4.4)], NOW, LIMIT)).code).toBe("RATE_MISSING");
  });
});

describe("the comparison as text", () => {
  test("each rate has its source and read time, and the higher one is named", () => {
    expect(describeComparison([kamino(3.9763), jupiter(4.4)], NOW, LIMIT)).toEqual([
      "Kamino        3.976% APR  read 2026-11-24T07:59:59.000Z  source Kamino reserve D6q6 (slot 1)",
      "Jupiter Lend  4.400% APR  read 2026-11-24T07:59:59.000Z  source https://jup.example/earn/tokens",
      "Higher: Jupiter Lend at 4.400% APR",
    ]);
  });

  test("with one rate missing it still shows the other, and names no higher one", () => {
    expect(describeComparison([{ lender: "kamino", error: "RPC timed out" }, jupiter(4.4)], NOW, LIMIT)).toEqual([
      "Kamino        not read: RPC timed out",
      "Jupiter Lend  4.400% APR  read 2026-11-24T07:59:59.000Z  source https://jup.example/earn/tokens",
      "No choice: Kamino's rate could not be read: RPC timed out",
    ]);
  });
});

describe("USDC amounts", () => {
  test.each([
    ["100", 100_000_000n],
    ["0.000001", 1n],
    ["12.5", 12_500_000n],
    [" 7 ", 7_000_000n],
  ])("%s parses to %s base units", (text, units) => {
    expect(parseUsdc(text)).toBe(units);
  });

  test.each(["", "0", "0.000000", "-5", "1.0000001", "1e6", "abc", "1,000", "0x10", "1."])('"%s" is refused', (text) => {
    expect(refusal(() => parseUsdc(text)).code).toBe("BAD_AMOUNT");
  });

  test("base units format with six decimals", () => {
    expect(formatUsdc(99_999_999n)).toBe("99.999999");
    expect(formatUsdc(100_000_000n)).toBe("100.000000");
    expect(formatUsdc(1n)).toBe("0.000001");
  });
});
