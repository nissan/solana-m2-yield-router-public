// Kamino Lend through its SDK. The position is the reserve's cTokens held in
// the wallet: no obligation account, because nothing is borrowed against it.
import { DEFAULT_RECENT_SLOT_DURATION_MS, KaminoAction, KaminoMarket, type KaminoReserve, PROGRAM_ID, VanillaObligation, getSingleReserve } from "@kamino-finance/klend-sdk";
import { type Address, type Instruction, type KeyPairSigner, type TransactionSigner, address } from "@solana/kit";
import { type Chain, type LedgerInstant, readLedgerInstant, tokenBalance } from "../chain.ts";
import { KAMINO_MAIN_MARKET, KAMINO_SOL_RESERVE, KAMINO_USDC_RESERVE, USDC_MINT } from "../config.ts";
import type { RateReading } from "../rates.ts";

type Loaded = { market: KaminoMarket; reserve: KaminoReserve; instant: LedgerInstant };

/**
 * One reserve of the market, checked to be the market's and the mint's. Read by address, not by
 * listing the market: listing reads every reserve the program owns (`getProgramAccounts`), which a
 * fork passes on to mainnet, and which the public endpoint failed now and then.
 */
async function loadReserve(chain: Chain, address: Address, mint: Address, rewardsMaxAprBps: number): Promise<KaminoReserve> {
  const reserve = await getSingleReserve(address, chain.rpc as never, DEFAULT_RECENT_SLOT_DURATION_MS, undefined, undefined, rewardsMaxAprBps);
  if (reserve.state.lendingMarket !== KAMINO_MAIN_MARKET) throw new Error(`Kamino reserve ${address} is not in market ${KAMINO_MAIN_MARKET}`);
  if (reserve.getLiquidityMint() !== mint) throw new Error(`Kamino reserve ${address} is for mint ${reserve.getLiquidityMint()}, not ${mint}`);
  return reserve;
}

async function load(chain: Chain): Promise<Loaded> {
  // The SDK is typed against its own copy of kit (8.3.0); a kit 8.6.0 client is the same object at run time.
  const bare = await KaminoMarket.load(chain.rpc as never, KAMINO_MAIN_MARKET, DEFAULT_RECENT_SLOT_DURATION_MS, PROGRAM_ID, false);
  if (!bare) throw new Error(`Kamino market ${KAMINO_MAIN_MARKET} did not load`);
  const reserve = await loadReserve(chain, KAMINO_USDC_RESERVE, USDC_MINT, bare.state.reserveRewardsMaxAprBps);
  const market = KaminoMarket.loadWithReserves(chain.rpc as never, bare.state, new Map([[reserve.address, reserve]]), KAMINO_MAIN_MARKET, DEFAULT_RECENT_SLOT_DURATION_MS);
  return { market, reserve, instant: await readLedgerInstant(chain) };
}

/**
 * Kamino's rate as a simple yearly rate (APR): the supply APR plus the reserve-rewards APR,
 * both from on-chain state. The library's `totalSupplyAPY` compounds the supply APR every slot;
 * that is a different kind of number from Jupiter Lend's, and a deposit's growth on a fork
 * matched the APR, not the APY (M2-007).
 */
export function kaminoSupplyApr(reserve: KaminoReserve, instant: LedgerInstant): { supply: number; rewards: number; total: number } {
  const supply = reserve.calculateSupplyAPR(instant, 0);
  // What the rewards budget is paying now; zero while it is empty.
  const rewards = reserve.calculateEffectiveReserveRewardsSupplyAPR(instant, 0);
  return { supply, rewards, total: supply + rewards };
}

export async function readKaminoRate(chain: Chain, now: () => Date): Promise<RateReading> {
  const { reserve, instant } = await load(chain);
  const apr = kaminoSupplyApr(reserve, instant);
  const pct = (x: number) => `${(x * 100).toFixed(3)}%`;
  return {
    lender: "kamino",
    ratePercent: apr.total * 100,
    source: `Kamino reserve ${reserve.address} (supply APR ${pct(apr.supply)} + reserve rewards APR ${pct(apr.rewards)}, from on-chain state at slot ${instant.slot}, via ${new URL(chain.rpcUrl).host})`,
    readAt: now(),
  };
}

/** The reserve and the chain's clock, for tests that compare the rate with what a deposit earns. */
export async function loadKaminoUsdcReserve(chain: Chain): Promise<{ reserve: KaminoReserve; instant: LedgerInstant }> {
  const { reserve, instant } = await load(chain);
  return { reserve, instant };
}

function instructionsOf(action: KaminoAction): Instruction[] {
  return [...action.computeBudgetIxs, ...action.setupIxs, ...action.lendingIxs, ...action.cleanupIxs] as unknown as Instruction[];
}

export async function kaminoDepositInstructions(chain: Chain, owner: TransactionSigner, amount: bigint): Promise<Instruction[]> {
  const { market, reserve, instant } = await load(chain);
  const action = await KaminoAction.buildDepositReserveLiquidityTxns({
    kaminoMarket: market,
    amount: amount.toString(),
    reserveAddress: reserve.address,
    owner: owner as never,
    obligation: new VanillaObligation(PROGRAM_ID),
    scopeRefreshConfig: undefined,
    currentLedgerInstant: instant,
  });
  return instructionsOf(action);
}

export type KaminoPosition = { shares: bigint; usdc: bigint };

/** cTokens held, and what they would redeem for at the reserve's estimated exchange rate. */
export async function readKaminoPosition(chain: Chain, owner: KeyPairSigner["address"]): Promise<KaminoPosition> {
  const { reserve, instant } = await load(chain);
  const shares = await tokenBalance(chain, owner, reserve.getCTokenMint());
  if (shares === 0n) return { shares, usdc: 0n };
  const cTokensPerUsdc = reserve.getEstimatedCollateralExchangeRate(instant, 0);
  return { shares, usdc: BigInt(cTokensPerUsdc.pow(-1).mul(shares.toString()).floor().toFixed(0)) };
}

/** Redeems every cToken the wallet holds. Empty when it holds none. */
export async function kaminoWithdrawAllInstructions(chain: Chain, owner: TransactionSigner): Promise<Instruction[]> {
  const { market, reserve, instant } = await load(chain);
  const shares = await tokenBalance(chain, owner.address, reserve.getCTokenMint());
  if (shares === 0n) return [];
  const action = await KaminoAction.buildRedeemReserveCollateralTxns({
    kaminoMarket: market,
    amount: shares.toString(),
    reserveAddress: reserve.address,
    owner: owner as never,
    obligation: new VanillaObligation(PROGRAM_ID),
    scopeRefreshConfig: undefined,
    currentLedgerInstant: instant,
  });
  return instructionsOf(action);
}

/** The mint of the reserve's cTokens, which is what a Kamino position is held as. */
export async function kaminoShareMint(chain: Chain): Promise<Address> {
  return (await load(chain)).reserve.getCTokenMint();
}

const WRAPPED_SOL_MINT = address("So11111111111111111111111111111111111111112");

/** US dollars per SOL, from the oracle price Kamino's own SOL reserve is running on. */
export async function readSolPriceUsd(chain: Chain): Promise<{ usd: number; source: string }> {
  const bare = await KaminoMarket.load(chain.rpc as never, KAMINO_MAIN_MARKET, DEFAULT_RECENT_SLOT_DURATION_MS, PROGRAM_ID, false);
  if (!bare) throw new Error(`Kamino market ${KAMINO_MAIN_MARKET} did not load`);
  const reserve = await loadReserve(chain, KAMINO_SOL_RESERVE, WRAPPED_SOL_MINT, bare.state.reserveRewardsMaxAprBps);
  if (!reserve.hasValidOraclePrice()) throw new Error("Kamino's SOL reserve has no usable oracle price");
  return { usd: reserve.getOracleMarketPrice().toNumber(), source: `oracle price of Kamino reserve ${reserve.address}` };
}
