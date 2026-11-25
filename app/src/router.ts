// The router: compare, deposit, position, withdraw. The commands and, later, the page call these.
import { type Address, type KeyPairSigner, createNoopSigner } from "@solana/kit";
import { type Advice, type AdviceInput, DEFAULT_HORIZON_DAYS, advise } from "./advice.ts";
import { type Chain, assertFork, estimateFeeLamports, newTokenAccountRentLamports, sendInstructions, tokenBalance } from "./chain.ts";
import { FRESHNESS_LIMIT_MS, USDC_MINT } from "./config.ts";
import { type JupiterApi, jupiterApiFromEnv, jupiterDepositInstructions, jupiterShareMint, jupiterWithdrawAllInstructions, readJupiterPosition, readJupiterRate } from "./lenders/jupiter.ts";
import { kaminoDepositInstructions, kaminoShareMint, kaminoWithdrawAllInstructions, readKaminoPosition, readKaminoRate, readSolPriceUsd } from "./lenders/kamino.ts";
import { type Lender, type RateReading, type RateResult, LENDERS, RouterRefusal, chooseLender, formatUsdc, isReading } from "./rates.ts";

export type RouterOptions = {
  chain: Chain;
  jupiter?: JupiterApi;
  now?: () => Date;
  freshnessLimitMs?: number;
};

export type Position = { lender: Lender; shares: bigint; usdc: bigint };
export type DepositResult = { chosen: RateReading; rates: RateResult[]; amount: bigint; signature: string };
export type Recommendation = { input: AdviceInput; advice: Advice };
export type WithdrawResult = { lender: Lender; signature: string; usdcReceived: bigint };

export function createRouter(options: RouterOptions) {
  const chain = options.chain;
  const jupiter = options.jupiter ?? jupiterApiFromEnv();
  const now = options.now ?? (() => new Date());
  const freshnessLimitMs = options.freshnessLimitMs ?? FRESHNESS_LIMIT_MS;

  /** Both rates. A rate that cannot be read comes back as a failure, not a throw, so the other still shows. */
  async function readRates(): Promise<RateResult[]> {
    const readers: Record<Lender, () => Promise<RateReading>> = {
      kamino: () => readKaminoRate(chain, now),
      jupiter: () => readJupiterRate(jupiter, now),
    };
    return Promise.all(
      LENDERS.map((lender) => readers[lender]().catch((error: unknown): RateResult => ({ lender, error: error instanceof Error ? error.message : String(error) }))),
    );
  }

  /**
   * Deposits with the lender that pays more. `rates` lets a caller act on the
   * rates it showed the depositor; they are checked for freshness here either way.
   */
  async function deposit(owner: KeyPairSigner, amount: bigint, rates?: RateResult[]): Promise<DepositResult> {
    await assertFork(chain.rpcUrl);
    const used = rates ?? (await readRates());
    const chosen = chooseLender(used, now(), freshnessLimitMs);
    if (amount <= 0n) throw new RouterRefusal("BAD_AMOUNT", "the amount must be more than zero");
    const held = await tokenBalance(chain, owner.address, USDC_MINT);
    if (held < amount) {
      throw new RouterRefusal("INSUFFICIENT_USDC", `the wallet holds ${formatUsdc(held)} USDC, less than the ${formatUsdc(amount)} asked for`);
    }
    const instructions =
      chosen.lender === "kamino" ? await kaminoDepositInstructions(chain, owner, amount) : await jupiterDepositInstructions(jupiter, owner, amount);
    const signature = await sendInstructions(chain, owner, instructions);
    return { chosen, rates: used, amount, signature };
  }

  /** What the wallet holds at each lender; lenders with nothing are left out. */
  async function positions(owner: KeyPairSigner["address"]): Promise<Position[]> {
    const [kamino, jup] = await Promise.all([readKaminoPosition(chain, owner), readJupiterPosition(jupiter, chain, owner)]);
    const all: Position[] = [
      { lender: "kamino", ...kamino },
      { lender: "jupiter", ...jup },
    ];
    return all.filter((p) => p.shares > 0n);
  }

  /** Withdraws everything from every lender the wallet has a position with. */
  async function withdrawAll(owner: KeyPairSigner): Promise<WithdrawResult[]> {
    await assertFork(chain.rpcUrl);
    const results: WithdrawResult[] = [];
    for (const lender of LENDERS) {
      const instructions =
        lender === "kamino" ? await kaminoWithdrawAllInstructions(chain, owner) : await jupiterWithdrawAllInstructions(jupiter, chain, owner);
      if (instructions.length === 0) continue;
      const before = await tokenBalance(chain, owner.address, USDC_MINT);
      const signature = await sendInstructions(chain, owner, instructions);
      const after = await tokenBalance(chain, owner.address, USDC_MINT);
      results.push({ lender, signature, usdcReceived: after - before });
    }
    return results;
  }

  /**
   * For each position, whether moving it to the other lender is worth what
   * the move costs. Advice only: the two transactions are built to be priced,
   * with a signer that cannot sign, and nothing is sent.
   */
  async function recommend(owner: Address, horizonDays: number = DEFAULT_HORIZON_DAYS): Promise<Recommendation[]> {
    const rates = await readRates();
    // The same rule as a deposit: no advice from a rate that is missing or stale.
    chooseLender(rates, now(), freshnessLimitMs);
    const readings = rates.filter(isReading);
    const held = await positions(owner);
    if (held.length === 0) return [];
    const payer = createNoopSigner(owner);
    const sol = await readSolPriceUsd(chain);
    const results: Recommendation[] = [];
    for (const position of held) {
      const current = readings.find((r) => r.lender === position.lender)!;
      const other = readings.find((r) => r.lender !== position.lender)!;
      const withdraw = position.lender === "kamino" ? await kaminoWithdrawAllInstructions(chain, payer) : await jupiterWithdrawAllInstructions(jupiter, chain, payer);
      const depositAt =
        other.lender === "kamino" ? await kaminoDepositInstructions(chain, payer, position.usdc) : await jupiterDepositInstructions(jupiter, payer, position.usdc);
      const shareMint = other.lender === "kamino" ? await kaminoShareMint(chain) : await jupiterShareMint(jupiter);
      const input: AdviceInput = {
        position,
        current,
        other,
        horizonDays,
        costs: {
          withdrawFeeLamports: await estimateFeeLamports(chain, owner, withdraw),
          depositFeeLamports: await estimateFeeLamports(chain, owner, depositAt),
          newAccountRentLamports: await newTokenAccountRentLamports(chain, owner, shareMint),
          solPriceUsd: sol.usd,
          solPriceSource: sol.source,
        },
      };
      results.push({ input, advice: advise(input) });
    }
    return results;
  }

  return { readRates, deposit, positions, withdrawAll, recommend, now, freshnessLimitMs };
}

export type Router = ReturnType<typeof createRouter>;
