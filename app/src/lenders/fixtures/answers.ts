// Real answers from Jupiter Lend's API (captured 24 November 2026, signer
// 7u3He…5PfF), re-pointed at a test wallet: its address as signer, its own
// token accounts as source and destination, and the amount asked for.
// Everything else is byte for byte what the API sent.
import type { Address } from "@solana/kit";
import { tokenAccountOf } from "../../chain.ts";
import { JLUSDC_MINT, USDC_MINT } from "../../config.ts";
import type { ApiInstruction } from "../jupiter-check.ts";
import deposit from "./jupiter-deposit-instructions.json" with { type: "json" };
import redeem from "./jupiter-redeem-instructions.json" with { type: "json" };

export async function realAnswer(kind: "deposit" | "redeem", owner: Address, amount: bigint): Promise<ApiInstruction[]> {
  const ix = structuredClone((kind === "deposit" ? deposit : redeem).instructions[0]!) as ApiInstruction;
  const [from, to] = kind === "deposit" ? [USDC_MINT, JLUSDC_MINT] : [JLUSDC_MINT, USDC_MINT];
  ix.accounts[0]!.pubkey = owner;
  ix.accounts[1]!.pubkey = await tokenAccountOf(owner, from);
  ix.accounts[2]!.pubkey = await tokenAccountOf(owner, to);
  const data = Buffer.from(ix.data, "base64");
  data.writeBigUInt64LE(amount, 8);
  ix.data = data.toString("base64");
  return [ix];
}
