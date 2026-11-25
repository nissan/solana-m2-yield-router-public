import { address } from "@solana/kit";

/** Mainnet USDC. Lenders' USDC markets are looked up by this mint, never by symbol. */
export const USDC_MINT = address("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
export const USDC_DECIMALS = 6;

/** Kamino Lend's main market. */
export const KAMINO_MAIN_MARKET = address("7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF");
/**
 * The main market's USDC reserve: the largest of the reserves for the USDC mint (more than one is
 * called "USDC", and the first listed is nearly empty). Named here so that only this account is read,
 * not every reserve in the market; on load it is checked to be in that market and for that mint.
 */
export const KAMINO_USDC_RESERVE = address("D6q6wuQSrifJKZYpR1M8R4YawnLDtDsMmWM1NbBmgJ59");
/** The main market's SOL reserve, read only for its oracle's SOL price. */
export const KAMINO_SOL_RESERVE = address("d4A2prbA2whesmvHaL88BH6Ewn5N4bTSU2Ze8P6Bc4Q");

/** Jupiter Lend's keyless host: five requests in ten seconds. */
export const JUPITER_LEND_API = "https://lite-api.jup.ag/lend/v1";
/** The host that takes a key from Jupiter's developer platform in `x-api-key`. */
export const JUPITER_LEND_API_KEYED = "https://api.jup.ag/lend/v1";

/** A rate read longer ago than this is not acted on. */
export const FRESHNESS_LIMIT_MS = 60_000;

/** Jupiter Lend's lending program, and the liquidity program it calls. From Jupiter's documentation, checked against the chain. */
export const JUPITER_LEND_PROGRAM = address("jup3YeL8QhtSx1e253b2FDvsMNC87fDrgQZivbrndc9");
export const JUPITER_LIQUIDITY_PROGRAM = address("jupeiUmn818Jg1ekPURTpr4mFo29p46vygyykFJ3wZC");
/** jlUSDC, the token a Jupiter Lend USDC position is held as. A constant here, so the API is not what says which mint it is. */
export const JLUSDC_MINT = address("9BEcn9aPEmhSPbPQeFGjidRiEKki46fVQDyPpSQXPA2D");
