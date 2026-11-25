// Is moving to the other lender worth what the move costs? Pure arithmetic:
// every number it uses is handed in, and nothing here reads a chain or moves funds.
import { type Lender, type RateReading, LENDER_NAMES, formatUsdc } from "./rates.ts";

/** Days of the higher rate a move must pay for itself within, unless the caller says otherwise. */
export const DEFAULT_HORIZON_DAYS = 30;

/** What one move costs, each part in lamports, and the price that turns lamports into dollars. */
export type MoveCosts = {
  /** Network fee of the withdrawal from the current lender. */
  withdrawFeeLamports: bigint;
  /** Network fee of the deposit at the other lender. */
  depositFeeLamports: bigint;
  /**
   * Rent for the other lender's token account when the wallet does not have
   * one yet; zero when it does. It comes back only if the account is closed,
   * which this tool never does, so it is counted as a cost.
   */
  newAccountRentLamports: bigint;
  /** US dollars per SOL, and where that came from. */
  solPriceUsd: number;
  solPriceSource: string;
};

export type AdviceInput = {
  /** The position being judged: where it is and what it would withdraw for now, in USDC base units. */
  position: { lender: Lender; usdc: bigint };
  current: RateReading;
  other: RateReading;
  costs: MoveCosts;
  horizonDays: number;
};

export type Advice = {
  recommendation: "move" | "stay";
  from: Lender;
  to: Lender;
  /** The other lender's rate minus the current one's, in percentage points. Negative when the current one pays more. */
  gapPercent: number;
  /** The cost of the move in US dollars, and its three parts. */
  costUsd: number;
  feesUsd: number;
  rentUsd: number;
  /** What the higher rate would add per day at today's rates, in US dollars. Zero or less when there is no gain. */
  extraPerDayUsd: number;
  /** Days of that gain needed to pay for the move. Null when there is no gain to pay with. */
  breakEvenDays: number | null;
  /** The gap that would break even in exactly `horizonDays` for this position and this cost. */
  breakEvenGapPercent: number;
  horizonDays: number;
  reason: string;
};

const LAMPORTS_PER_SOL = 1_000_000_000;

export function advise(input: AdviceInput): Advice {
  const { position, current, other, costs, horizonDays } = input;
  if (!(horizonDays > 0) || !Number.isFinite(horizonDays)) throw new RangeError(`the horizon must be a positive number of days, not ${horizonDays}`);
  if (!(costs.solPriceUsd > 0) || !Number.isFinite(costs.solPriceUsd)) throw new RangeError(`the SOL price must be a positive number, not ${costs.solPriceUsd}`);

  const usd = (lamports: bigint) => (Number(lamports) / LAMPORTS_PER_SOL) * costs.solPriceUsd;
  const feesUsd = usd(costs.withdrawFeeLamports + costs.depositFeeLamports);
  const rentUsd = usd(costs.newAccountRentLamports);
  const costUsd = feesUsd + rentUsd;

  // USDC is counted as one dollar. Both rates are yearly percentages taken as simple interest over the horizon.
  const principalUsd = Number(position.usdc) / 1_000_000;
  const gapPercent = other.ratePercent - current.ratePercent;
  const extraPerDayUsd = (principalUsd * gapPercent) / 100 / 365;
  const breakEvenDays = extraPerDayUsd > 0 ? costUsd / extraPerDayUsd : null;
  const breakEvenGapPercent = principalUsd > 0 ? (costUsd * 365 * 100) / (principalUsd * horizonDays) : Number.POSITIVE_INFINITY;

  const base = { from: position.lender, to: other.lender, gapPercent, costUsd, feesUsd, rentUsd, extraPerDayUsd, breakEvenDays, breakEvenGapPercent, horizonDays };
  if (breakEvenDays === null) {
    const why = gapPercent === 0 ? "both lenders pay the same" : `${LENDER_NAMES[position.lender]} already pays more`;
    return { ...base, recommendation: "stay", reason: `${why}, so a move would cost money and earn none` };
  }
  if (breakEvenDays <= horizonDays) {
    return { ...base, recommendation: "move", reason: `the move pays for itself in ${formatDays(breakEvenDays)}, inside the ${horizonDays}-day horizon` };
  }
  return { ...base, recommendation: "stay", reason: `the move would take ${formatDays(breakEvenDays)} to pay for itself, longer than the ${horizonDays}-day horizon` };
}

function formatDays(days: number): string {
  if (days < 1) return "under a day";
  if (days < 10) return `${days.toFixed(1)} days`;
  return `${Math.round(days)} days`;
}

const dollars = (value: number) => `$${value < 0.01 && value > 0 ? value.toFixed(6) : value.toFixed(4)}`;
const points = (value: number) => `${value >= 0 ? "+" : ""}${value.toFixed(3)} points`;

/** The advice as lines of text: the recommendation first, then every number behind it. */
export function describeAdvice(advice: Advice, input: AdviceInput): string[] {
  const { costs, position, current, other } = input;
  const verdict = advice.recommendation === "move" ? `Move to ${LENDER_NAMES[advice.to]}` : `Stay with ${LENDER_NAMES[advice.from]}`;
  return [
    `${verdict}: ${advice.reason}.`,
    `  Position        about ${formatUsdc(position.usdc)} USDC at ${LENDER_NAMES[position.lender]}`,
    `  Rates           ${LENDER_NAMES[current.lender]} ${current.ratePercent.toFixed(3)}%, ${LENDER_NAMES[other.lender]} ${other.ratePercent.toFixed(3)}% APR (gap ${points(advice.gapPercent)})`,
    `  Gain            ${advice.extraPerDayUsd > 0 ? `${dollars(advice.extraPerDayUsd)} a day more at ${LENDER_NAMES[other.lender]}, at today's rates` : "none"}`,
    `  Cost of moving  ${dollars(advice.costUsd)}: network fees ${dollars(advice.feesUsd)}${costs.newAccountRentLamports > 0n ? `, rent for a new ${LENDER_NAMES[other.lender]} token account ${dollars(advice.rentUsd)}` : `, no new account needed`}`,
    `  SOL price       $${costs.solPriceUsd.toFixed(2)} (${costs.solPriceSource})`,
    `  Break-even      ${advice.breakEvenDays === null ? "never, at these rates" : formatDays(advice.breakEvenDays)}; a gap of ${Number.isFinite(advice.breakEvenGapPercent) ? `${advice.breakEvenGapPercent.toFixed(3)} points` : "any size"} would break even in ${advice.horizonDays} days`,
    "  Advice only: nothing was signed or sent. Rates move, so the break-even is today's, not a promise.",
  ];
}
