import { generateKeyPairSigner } from "@solana/kit";
import { describe, expect, test } from "vitest";
import { tokenAccountOf } from "../chain.ts";
import { JLUSDC_MINT, USDC_MINT } from "../config.ts";
import { RouterRefusal } from "../rates.ts";
import { realAnswer } from "./fixtures/answers.ts";
import { type ApiInstruction, checkJupiterInstructions } from "./jupiter-check.ts";

const AMOUNT = 12_500_000n;
const owner = (await generateKeyPairSigner()).address;
const stranger = (await generateKeyPairSigner()).address;

async function refusalOf(kind: "deposit" | "redeem", answer: unknown, amount = AMOUNT): Promise<RouterRefusal> {
  try {
    await checkJupiterInstructions(kind, answer, owner, amount);
  } catch (error) {
    if (error instanceof RouterRefusal) return error;
    throw error;
  }
  throw new Error("expected a refusal, and the answer was accepted");
}
const edit = async (kind: "deposit" | "redeem", change: (ix: ApiInstruction) => void) => {
  const answer = await realAnswer(kind, owner, AMOUNT);
  change(answer[0]!);
  return answer;
};

describe.each(["deposit", "redeem"] as const)("%s", (kind) => {
  test("S1: the API's real answer, for this wallet and amount, passes", async () => {
    const answer = await realAnswer(kind, owner, AMOUNT);
    expect(await checkJupiterInstructions(kind, answer, owner, AMOUNT)).toBe(answer);
  });

  test("S2: the receiving token account is someone else's: refused, naming it", async () => {
    const theirs = await tokenAccountOf(stranger, kind === "deposit" ? JLUSDC_MINT : USDC_MINT);
    const error = await refusalOf(kind, await edit(kind, (ix) => void (ix.accounts[2]!.pubkey = theirs)));
    expect([error.code, error.lender]).toEqual(["UNEXPECTED_INSTRUCTIONS", "jupiter"]);
    expect(error.message).toContain(`${theirs} as the account that receives the ${kind === "deposit" ? "jlUSDC" : "USDC"}, which is not the wallet's own`);
  });

  test("S2: the paying token account is someone else's: refused", async () => {
    const theirs = await tokenAccountOf(stranger, kind === "deposit" ? USDC_MINT : JLUSDC_MINT);
    expect((await refusalOf(kind, await edit(kind, (ix) => void (ix.accounts[1]!.pubkey = theirs)))).message).toContain(theirs);
  });

  test("S3: a different amount is refused, with both amounts", async () => {
    expect((await refusalOf(kind, await realAnswer(kind, owner, AMOUNT + 1n))).message).toContain(`an amount of ${AMOUNT + 1n} where ${AMOUNT} was asked for`);
  });

  test("S3: a second instruction is refused", async () => {
    const answer = await realAnswer(kind, owner, AMOUNT);
    expect((await refusalOf(kind, [...answer, answer[0]])).message).toContain("2 instructions where one was expected");
  });

  test("S3: another program is refused", async () => {
    const error = await refusalOf(kind, await edit(kind, (ix) => void (ix.programId = stranger)));
    expect(error.message).toContain(`an instruction for program ${stranger}, not Jupiter Lend's`);
  });

  test("S3: another instruction of the same program is refused", async () => {
    const other = kind === "deposit" ? [183, 18, 70, 156, 148, 109, 161, 34] : [242, 35, 198, 137, 82, 225, 242, 182];
    const error = await refusalOf(
      kind,
      await edit(kind, (ix) => {
        const data = Buffer.from(ix.data, "base64");
        Buffer.from(other).copy(data, 0);
        ix.data = data.toString("base64");
      }),
    );
    expect(error.message).toContain(`a different instruction of the same program, not ${kind}`);
  });

  test("S3: a second signer is refused", async () => {
    const error = await refusalOf(kind, await edit(kind, (ix) => void (ix.accounts[4]!.isSigner = true)));
    expect(error.message).toMatch(/2 signers .* where the wallet alone should sign/);
  });

  test("S3: someone else as the signer is refused", async () => {
    expect((await refusalOf(kind, await edit(kind, (ix) => void (ix.accounts[0]!.pubkey = stranger)))).message).toContain(`${stranger} as the signer`);
  });

  test("a different token, or a different liquidity program, is refused", async () => {
    const mintIndex = kind === "deposit" ? 3 : 5;
    expect((await refusalOf(kind, await edit(kind, (ix) => void (ix.accounts[mintIndex]!.pubkey = stranger)))).message).toContain("as the token being");
    const liquidity = kind === "deposit" ? 12 : 13;
    expect((await refusalOf(kind, await edit(kind, (ix) => void (ix.accounts[liquidity]!.pubkey = stranger)))).message).toContain("as the liquidity program");
  });

  test("an account missing or added is refused", async () => {
    expect((await refusalOf(kind, await edit(kind, (ix) => void ix.accounts.pop()))).message).toMatch(/accounts where the .* instruction takes/);
    const extra = await edit(kind, (ix) => void ix.accounts.push({ ...ix.accounts[4]! }));
    expect((await refusalOf(kind, extra)).message).toMatch(/accounts where/);
  });
});

describe("answers that are not instructions", () => {
  test.each([
    ["nothing", undefined, "no instructions"],
    ["an empty list", [], "no instructions"],
    ["something that is not a list", { instructions: [] }, "no instructions"],
    ["an instruction with no accounts", [{ programId: USDC_MINT, data: "" }], "without a program, data and accounts"],
    ["an account that is not an address", [{ programId: "jup3YeL8QhtSx1e253b2FDvsMNC87fDrgQZivbrndc9", data: "", accounts: [{ pubkey: "nope", isSigner: true, isWritable: true }] }], "not an address"],
  ])("%s is refused", async (_name, answer, message) => {
    expect((await refusalOf("deposit", answer)).message).toContain(message);
  });
});
