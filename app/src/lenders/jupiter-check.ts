// Jupiter Lend's API answers a request with instructions for the wallet to
// sign. This checks an answer against the request before anything is signed
// or simulated: an answer is data from the network, and a wrong one could
// name someone else's token account as the destination.
//
// The layouts are the ones Jupiter documents for its lending program
// (developers.jup.ag, "Earn CPI Integration") and its API returns today.
// The lender's own state accounts are not checked here: its program checks
// those itself, and rejects a transaction that names the wrong ones.
import { type Address, address } from "@solana/kit";
import { ASSOCIATED_TOKEN_PROGRAM_ADDRESS, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { tokenAccountOf } from "../chain.ts";
import { JLUSDC_MINT, JUPITER_LEND_PROGRAM, JUPITER_LIQUIDITY_PROGRAM, USDC_MINT } from "../config.ts";
import { RouterRefusal } from "../rates.ts";

export type ApiInstruction = { programId: string; accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[]; data: string };

const SYSTEM_PROGRAM = address("11111111111111111111111111111111");

type Layout = {
  /** The first eight bytes of the instruction's data: sha256("global:<name>")[0..8]. */
  discriminator: readonly number[];
  accounts: number;
  /** The wallet's token account the tokens leave, and the one they arrive in. */
  source: { index: number; mint: Address; name: string };
  destination: { index: number; mint: Address; name: string };
  fixed: readonly { index: number; is: Address; name: string }[];
};

const LAYOUTS: Record<"deposit" | "redeem", Layout> = {
  deposit: {
    discriminator: [242, 35, 198, 137, 82, 225, 242, 182],
    accounts: 17,
    source: { index: 1, mint: USDC_MINT, name: "the USDC account the deposit is taken from" },
    destination: { index: 2, mint: JLUSDC_MINT, name: "the account that receives the jlUSDC" },
    fixed: [
      { index: 3, is: USDC_MINT, name: "the token being deposited" },
      { index: 6, is: JLUSDC_MINT, name: "the jlUSDC mint" },
      { index: 12, is: JUPITER_LIQUIDITY_PROGRAM, name: "the liquidity program" },
      { index: 14, is: TOKEN_PROGRAM_ADDRESS, name: "the token program" },
      { index: 15, is: ASSOCIATED_TOKEN_PROGRAM_ADDRESS, name: "the associated-token program" },
      { index: 16, is: SYSTEM_PROGRAM, name: "the system program" },
    ],
  },
  redeem: {
    discriminator: [184, 12, 86, 149, 70, 196, 97, 225],
    accounts: 18,
    source: { index: 1, mint: JLUSDC_MINT, name: "the jlUSDC account the shares are taken from" },
    destination: { index: 2, mint: USDC_MINT, name: "the account that receives the USDC" },
    fixed: [
      { index: 5, is: USDC_MINT, name: "the token being withdrawn" },
      { index: 6, is: JLUSDC_MINT, name: "the jlUSDC mint" },
      { index: 13, is: JUPITER_LIQUIDITY_PROGRAM, name: "the liquidity program" },
      { index: 15, is: TOKEN_PROGRAM_ADDRESS, name: "the token program" },
      { index: 16, is: ASSOCIATED_TOKEN_PROGRAM_ADDRESS, name: "the associated-token program" },
      { index: 17, is: SYSTEM_PROGRAM, name: "the system program" },
    ],
  },
};

function refuse(kind: string, what: string): never {
  throw new RouterRefusal("UNEXPECTED_INSTRUCTIONS", `Jupiter Lend's API answered the ${kind} request with something the router did not ask for: ${what}`, "jupiter");
}

/** True for a string that is a Solana address; an answer can hold anything. */
function isAddress(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    address(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Throws a refusal unless `answer` is exactly one instruction of the Jupiter
 * Lend program that does what was asked: this kind, this amount, signed by
 * `owner` alone, between `owner`'s own token accounts.
 * `amount` is USDC base units for a deposit and jlUSDC shares for a redeem.
 */
export async function checkJupiterInstructions(kind: "deposit" | "redeem", answer: unknown, owner: Address, amount: bigint): Promise<ApiInstruction[]> {
  const layout = LAYOUTS[kind];
  if (!Array.isArray(answer) || answer.length === 0) refuse(kind, "no instructions");
  if (answer.length !== 1) refuse(kind, `${answer.length} instructions where one was expected`);
  const ix = answer[0] as Partial<ApiInstruction>;
  if (typeof ix !== "object" || ix === null || !isAddress(ix.programId) || typeof ix.data !== "string" || !Array.isArray(ix.accounts)) {
    refuse(kind, "an instruction without a program, data and accounts");
  }
  if (ix.programId !== JUPITER_LEND_PROGRAM) refuse(kind, `an instruction for program ${ix.programId}, not Jupiter Lend's ${JUPITER_LEND_PROGRAM}`);

  const accounts = ix.accounts;
  if (accounts.some((a) => typeof a !== "object" || a === null || !isAddress(a.pubkey) || typeof a.isSigner !== "boolean" || typeof a.isWritable !== "boolean")) {
    refuse(kind, "an account that is not an address with signer and writable flags");
  }
  if (accounts.length !== layout.accounts) refuse(kind, `${accounts.length} accounts where the ${kind} instruction takes ${layout.accounts}`);

  const data = Buffer.from(ix.data, "base64");
  if (data.length !== 16) refuse(kind, `${data.length} bytes of data where the ${kind} instruction takes 16`);
  if (!layout.discriminator.every((byte, i) => data[i] === byte)) refuse(kind, `a different instruction of the same program, not ${kind}`);
  const asked = data.readBigUInt64LE(8);
  if (asked !== amount) refuse(kind, `an amount of ${asked} where ${amount} was asked for`);

  const signers = accounts.filter((a) => a.isSigner).map((a) => a.pubkey);
  if (accounts[0]!.pubkey !== owner || !accounts[0]!.isSigner) refuse(kind, `${accounts[0]!.pubkey} as the signer, not the wallet ${owner}`);
  if (signers.length !== 1) refuse(kind, `${signers.length} signers (${signers.join(", ")}) where the wallet alone should sign`);

  for (const side of [layout.source, layout.destination]) {
    const expected = await tokenAccountOf(owner, side.mint);
    const got = accounts[side.index]!.pubkey;
    if (got !== expected) refuse(kind, `${got} as ${side.name}, which is not the wallet's own (${expected})`);
  }
  for (const fixed of layout.fixed) {
    const got = accounts[fixed.index]!.pubkey;
    if (got !== fixed.is) refuse(kind, `${got} as ${fixed.name}, not ${fixed.is}`);
  }
  return answer as ApiInstruction[];
}
