// Jupiter Lend (Earn) through its HTTP API. The position is jlUSDC shares held in the wallet.
import { type Address, type Instruction, type TransactionSigner, AccountRole, address } from "@solana/kit";
import { getCreateAssociatedTokenIdempotentInstructionAsync } from "@solana-program/token";
import { type Chain, simulateUsdcReceived, tokenBalance } from "../chain.ts";
import { JLUSDC_MINT, JUPITER_LEND_API, JUPITER_LEND_API_KEYED, USDC_MINT } from "../config.ts";
import { type ApiInstruction, checkJupiterInstructions } from "./jupiter-check.ts";
import type { RateReading } from "../rates.ts";

export type JupiterApi = {
  baseUrl: string;
  fetch: typeof fetch;
  /** Sent as `x-api-key`. Never put into a message, a source line or a log. */
  apiKey?: string;
  /** Waits this many milliseconds; replaceable in tests. */
  sleep?: (ms: number) => Promise<void>;
};

type EarnToken = { address: string; assetAddress: string; supplyRate: string; rewardsRate: string; totalRate: string; convertToAssets: string };

/**
 * The API to use: with `JUPITER_API_KEY` set, the keyed host; without it, the
 * keyless one, which allows five requests in ten seconds.
 */
export function jupiterApiFromEnv(env: Record<string, string | undefined> = process.env): JupiterApi {
  const apiKey = env.JUPITER_API_KEY?.trim() || undefined;
  // One object per host and key, so every router in a process shares one pacer and one rate-limit window.
  const known = fromEnv.get(apiKey ?? "");
  if (known) return known;
  const made: JupiterApi = apiKey ? { baseUrl: JUPITER_LEND_API_KEYED, fetch, apiKey } : { baseUrl: JUPITER_LEND_API, fetch };
  fromEnv.set(apiKey ?? "", made);
  return made;
}
const fromEnv = new Map<string, JupiterApi>();

/**
 * The keyless host allows five requests in ten seconds and the keyed one ten (both read from
 * their `x-ratelimit-*` headers on 24 November 2026). Longer waits than this are not ours to sit through.
 */
const LONGEST_RATE_LIMIT_WAIT_MS = 12_000;
/** Tries of one request that keep meeting the limit before it is an error. */
const ATTEMPTS = 3;

/** Per API object: requests go one at a time, and none is sent before a window the API said was used up has reset. */
type Pacer = { last: Promise<unknown>; blockedUntil: number };
const pacers = new WeakMap<JupiterApi, Pacer>();

/**
 * When this API's current window resets, on this machine's clock. The reset is a Unix time on the
 * server's clock; the `date` header says what the server's clock read, so a skew between the two
 * clocks does not shorten the wait.
 */
function windowResetsAt(response: Response): number | undefined {
  const reset = Number(response.headers.get("x-ratelimit-reset")) * 1000;
  if (!Number.isFinite(reset) || reset <= 0) return undefined;
  const serverNow = Date.parse(response.headers.get("date") ?? "");
  return Date.now() + (reset - (Number.isFinite(serverNow) ? serverNow : Date.now())) + 250;
}

/**
 * One request, paced. Requests through one API object go one at a time. When an answer says the
 * window is used up, the next request waits for it to reset instead of being refused. A 429 that
 * names a reset a few seconds away is waited out and tried again, up to three tries in all; a 429
 * with no usable reset, or the third, is an error.
 */
async function call(api: JupiterApi, path: string, init?: RequestInit): Promise<unknown> {
  const pacer = pacers.get(api) ?? { last: Promise.resolve(), blockedUntil: 0 };
  pacers.set(api, pacer);
  const run = pacer.last.catch(() => undefined).then(() => send(api, pacer, path, init));
  pacer.last = run;
  return run;
}

async function send(api: JupiterApi, pacer: Pacer, path: string, init?: RequestInit): Promise<unknown> {
  const url = `${api.baseUrl}${path}`;
  const sleep = api.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  if (api.apiKey) init = { ...init, headers: { ...(init?.headers as Record<string, string> | undefined), "x-api-key": api.apiKey } };
  for (let attempt = 1; ; attempt++) {
    const waitMs = pacer.blockedUntil - Date.now();
    pacer.blockedUntil = 0;
    if (waitMs > 0) await sleep(Math.min(waitMs, LONGEST_RATE_LIMIT_WAIT_MS));
    const response = await api.fetch(url, init);
    const resetsAt = windowResetsAt(response);
    if (response.status === 429) {
      const waitFor = resetsAt === undefined ? Number.NaN : resetsAt - Date.now();
      if (attempt < ATTEMPTS && waitFor > 0 && waitFor <= LONGEST_RATE_LIMIT_WAIT_MS) {
        pacer.blockedUntil = resetsAt!;
        continue;
      }
      throw new Error(`${url} answered HTTP 429 (rate limited)`);
    }
    if (response.headers.get("x-ratelimit-remaining") === "0" && resetsAt !== undefined) pacer.blockedUntil = resetsAt;
    if (!response.ok) throw new Error(`${url} answered HTTP ${response.status}`);
    return response.json();
  }
}

async function usdcToken(api: JupiterApi): Promise<EarnToken> {
  const tokens = await call(api, "/earn/tokens");
  if (!Array.isArray(tokens)) throw new Error("/earn/tokens did not return a list");
  const token = (tokens as Partial<EarnToken>[]).find((t) => t.assetAddress === USDC_MINT);
  if (!token) throw new Error(`/earn/tokens lists no market for mint ${USDC_MINT}`);
  if (typeof token.address !== "string" || typeof token.totalRate !== "string" || typeof token.convertToAssets !== "string") {
    throw new Error("/earn/tokens returned the USDC market without address, totalRate or convertToAssets");
  }
  if (token.address !== JLUSDC_MINT) throw new Error(`/earn/tokens names ${token.address} as the USDC market's share token, not jlUSDC ${JLUSDC_MINT}`);
  return token as EarnToken;
}

/**
 * Jupiter Lend's rate as a simple yearly rate (APR): `supplyRate` plus `rewardsRate`, which the
 * API also gives summed as `totalRate`, all in hundredths of a percent. Jupiter's own read library
 * applies the supply rate linearly over seconds per year, so these are APRs, not APYs.
 */
export async function readJupiterRate(api: JupiterApi, now: () => Date): Promise<RateReading> {
  const token = await usdcToken(api);
  const parts = [token.supplyRate, token.rewardsRate, token.totalRate];
  if (!parts.every((p) => typeof p === "string" && /^\d+$/.test(p))) {
    throw new Error(`/earn/tokens returned rates ${JSON.stringify(parts)}, not three whole numbers`);
  }
  const [supply, rewards, total] = parts.map(Number) as [number, number, number];
  if (supply + rewards !== total) throw new Error(`/earn/tokens returned a totalRate of ${total} that is not supplyRate ${supply} plus rewardsRate ${rewards}`);
  const pct = (x: number) => `${(x / 100).toFixed(3)}%`;
  return {
    lender: "jupiter",
    ratePercent: total / 100,
    source: `${api.baseUrl}/earn/tokens (supply APR ${pct(supply)} + rewards APR ${pct(rewards)}, market ${token.address})`,
    readAt: now(),
  };
}

function toInstruction(ix: ApiInstruction): Instruction {
  return {
    programAddress: address(ix.programId),
    accounts: ix.accounts.map((a) => ({
      address: address(a.pubkey),
      role: a.isSigner ? (a.isWritable ? AccountRole.WRITABLE_SIGNER : AccountRole.READONLY_SIGNER) : a.isWritable ? AccountRole.WRITABLE : AccountRole.READONLY,
    })),
    data: Buffer.from(ix.data, "base64"),
  };
}

/** Asks the API for instructions and refuses an answer that is not what was asked for (see jupiter-check.ts). */
async function instructionsFrom(api: JupiterApi, kind: "deposit" | "redeem", owner: Address, amount: bigint): Promise<Instruction[]> {
  const body = kind === "deposit" ? { asset: USDC_MINT, amount: amount.toString(), signer: owner } : { asset: USDC_MINT, shares: amount.toString(), signer: owner };
  const result = (await call(api, `/earn/${kind}-instructions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })) as {
    instructions?: unknown;
  };
  return (await checkJupiterInstructions(kind, result.instructions, owner, amount)).map(toInstruction);
}

export async function jupiterDepositInstructions(api: JupiterApi, owner: TransactionSigner, amount: bigint): Promise<Instruction[]> {
  return [
    // The API's deposit expects the jlUSDC account to exist already.
    await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: owner, owner: owner.address, mint: await jupiterShareMint(api) }),
    ...(await instructionsFrom(api, "deposit", owner.address, amount)),
  ];
}

export type JupiterPosition = { shares: bigint; usdc: bigint };

/** The jlUSDC mint, which is what a Jupiter Lend position is held as. A constant: the API is checked against it, not trusted for it. */
export async function jupiterShareMint(_api: JupiterApi): Promise<Address> {
  return JLUSDC_MINT;
}

/**
 * jlUSDC held, and the USDC a full withdrawal would pay right now on the chain
 * we are connected to. The API's conversion rate describes mainnet at this
 * moment; a fork whose clock has moved is somewhere else, so the amount comes
 * from simulating the withdrawal there. Nothing is signed or sent.
 */
export async function readJupiterPosition(api: JupiterApi, chain: Chain, owner: Address): Promise<JupiterPosition> {
  const shares = await tokenBalance(chain, owner, await jupiterShareMint(api));
  if (shares === 0n) return { shares, usdc: 0n };
  const instructions = await instructionsFrom(api, "redeem", owner, shares);
  return { shares, usdc: await simulateUsdcReceived(chain, owner, instructions) };
}

/** Redeems every jlUSDC share the wallet holds. Empty when it holds none. */
export async function jupiterWithdrawAllInstructions(api: JupiterApi, chain: Chain, owner: TransactionSigner): Promise<Instruction[]> {
  const shares = await tokenBalance(chain, owner.address, await jupiterShareMint(api));
  if (shares === 0n) return [];
  return instructionsFrom(api, "redeem", owner.address, shares);
}
