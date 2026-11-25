// Pure decisions: which lender pays more, and when to refuse. No network, no clock of its own.

export const LENDERS = ["kamino", "jupiter"] as const;
export type Lender = (typeof LENDERS)[number];

export const LENDER_NAMES: Record<Lender, string> = { kamino: "Kamino", jupiter: "Jupiter Lend" };

export type RateReading = {
  lender: Lender;
  /** Simple yearly rate (APR) in percent, everything the lender adds to a deposit's value, on the same basis for both lenders. */
  ratePercent: number;
  /** Where the number came from, specific enough to read it again. */
  source: string;
  /** When this process received it. */
  readAt: Date;
};

/** A rate that could not be read, with the reason. */
export type RateFailure = { lender: Lender; error: string };
export type RateResult = RateReading | RateFailure;

export function isReading(result: RateResult): result is RateReading {
  return "ratePercent" in result;
}

export type RefusalCode = "RATE_MISSING" | "RATE_STALE" | "BAD_AMOUNT" | "BAD_HORIZON" | "INSUFFICIENT_USDC" | "NOT_A_FORK" | "UNEXPECTED_INSTRUCTIONS";

/** The router declined to act. Nothing was signed or sent. */
export class RouterRefusal extends Error {
  override name = "RouterRefusal";
  readonly code: RefusalCode;
  readonly lender: Lender | undefined;
  constructor(code: RefusalCode, message: string, lender?: Lender) {
    super(message);
    this.code = code;
    this.lender = lender;
  }
}

/**
 * The lender to deposit with: the higher rate, Kamino on an exact tie.
 * Refuses unless both rates were read and both are fresh, because a choice
 * between one known rate and one unknown rate is not a comparison.
 */
export function chooseLender(results: readonly RateResult[], now: Date, freshnessLimitMs: number): RateReading {
  const readings: RateReading[] = [];
  for (const lender of LENDERS) {
    const result = results.find((r) => r.lender === lender);
    if (!result || !isReading(result)) {
      const why = result ? result.error : "no reading was taken";
      throw new RouterRefusal("RATE_MISSING", `${LENDER_NAMES[lender]}'s rate could not be read: ${why}`, lender);
    }
    if (!Number.isFinite(result.ratePercent) || result.ratePercent < 0) {
      throw new RouterRefusal("RATE_MISSING", `${LENDER_NAMES[lender]}'s rate is not a usable number: ${result.ratePercent}`, lender);
    }
    const ageMs = now.getTime() - result.readAt.getTime();
    if (ageMs > freshnessLimitMs) {
      throw new RouterRefusal(
        "RATE_STALE",
        // Rounded up, so an age just past the limit does not print as equal to it.
        `${LENDER_NAMES[lender]}'s rate is stale: read ${Math.ceil(ageMs / 1000)}s ago, the limit is ${Math.round(freshnessLimitMs / 1000)}s`,
        lender,
      );
    }
    readings.push(result);
  }
  return readings.reduce((best, r) => (r.ratePercent > best.ratePercent ? r : best));
}

/** "12.5" USDC to base units. Refuses anything that is not a positive amount with at most six decimals. */
export function parseUsdc(text: string): bigint {
  const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(text.trim());
  if (!match) throw new RouterRefusal("BAD_AMOUNT", `"${text}" is not a USDC amount (digits, at most six decimals)`);
  const units = BigInt(match[1]!) * 1_000_000n + BigInt((match[2] ?? "").padEnd(6, "0"));
  if (units === 0n) throw new RouterRefusal("BAD_AMOUNT", "the amount must be more than zero");
  return units;
}

export function formatUsdc(units: bigint): string {
  const whole = units / 1_000_000n;
  const fraction = (units % 1_000_000n).toString().padStart(6, "0");
  return `${whole}.${fraction}`;
}

/** The comparison as lines of text: each rate with its source and read time, then the higher one. */
export function describeComparison(results: readonly RateResult[], now: Date, freshnessLimitMs: number): string[] {
  const lines = LENDERS.map((lender) => {
    const result = results.find((r) => r.lender === lender);
    if (!result || !isReading(result)) {
      return `${LENDER_NAMES[lender].padEnd(13)} not read: ${result ? result.error : "no reading was taken"}`;
    }
    return `${LENDER_NAMES[lender].padEnd(13)} ${result.ratePercent.toFixed(3)}% APR  read ${result.readAt.toISOString()}  source ${result.source}`;
  });
  try {
    const best = chooseLender(results, now, freshnessLimitMs);
    lines.push(`Higher: ${LENDER_NAMES[best.lender]} at ${best.ratePercent.toFixed(3)}% APR`);
  } catch (error) {
    if (!(error instanceof RouterRefusal)) throw error;
    lines.push(`No choice: ${error.message}`);
  }
  return lines;
}
