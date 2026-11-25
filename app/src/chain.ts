// The fork: connecting, the guard that it is a fork, balances and sending.
import {
  type Address,
  type Instruction,
  type KeyPairSigner,
  type Rpc,
  type RpcSubscriptions,
  type SolanaRpcApi,
  type SolanaRpcSubscriptionsApi,
  type TransactionMessageBytesBase64,
  type UnixTimestamp,
  appendTransactionMessageInstructions,
  assertIsTransactionWithBlockhashLifetime,
  compileTransaction,
  compileTransactionMessage,
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  createTransactionMessage,
  getBase64Decoder,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getCompiledTransactionMessageEncoder,
  getSignatureFromTransaction,
  pipe,
  sendAndConfirmTransactionFactory,
  setTransactionMessageFeePayer,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from "@solana/kit";
import { fetchSysvarClock } from "@solana/sysvars";
import { findAssociatedTokenPda, getTokenDecoder, getTokenSize, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { USDC_MINT } from "./config.ts";
import { RouterRefusal } from "./rates.ts";

export type Chain = {
  rpcUrl: string;
  rpc: Rpc<SolanaRpcApi>;
  rpcSubscriptions: RpcSubscriptions<SolanaRpcSubscriptionsApi>;
};

export function connect(rpcUrl: string, wsUrl: string): Chain {
  return { rpcUrl, rpc: createSolanaRpc(rpcUrl), rpcSubscriptions: createSolanaRpcSubscriptions(wsUrl) };
}

/**
 * Refuses unless the RPC is a Surfpool runtime on this machine. A fork of
 * mainnet answers with mainnet's genesis hash, so the genesis hash cannot
 * tell the two apart; Surfpool's own `surfnet_getSurfnetInfo` method can.
 * Every path that signs calls this first.
 */
export async function assertFork(rpcUrl: string, fetchFn: typeof fetch = fetch): Promise<void> {
  const host = new URL(rpcUrl).hostname;
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "[::1]") {
    throw new RouterRefusal("NOT_A_FORK", `refusing to sign: ${host} is not this machine, so it is not a local fork`);
  }
  let ok = false;
  try {
    const response = await fetchFn(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "surfnet_getSurfnetInfo", params: [] }),
    });
    const body = (await response.json()) as { result?: unknown; error?: unknown };
    ok = response.ok && body.result !== undefined && body.error === undefined;
  } catch {
    ok = false;
  }
  if (!ok) throw new RouterRefusal("NOT_A_FORK", `refusing to sign: ${rpcUrl} did not answer as a Surfpool fork`);
}

export type LedgerInstant = { slot: bigint; blockTime: UnixTimestamp };

/** The chain's own clock, which on a fork is not the wall clock. */
export async function readLedgerInstant(chain: Chain): Promise<LedgerInstant> {
  const clock = await fetchSysvarClock(chain.rpc);
  return { slot: clock.slot, blockTime: clock.unixTimestamp };
}

export async function tokenAccountOf(owner: Address, mint: Address): Promise<Address> {
  const [ata] = await findAssociatedTokenPda({ owner, mint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
  return ata;
}

/** Base units held by `owner` in `mint`; zero when the token account does not exist. */
export async function tokenBalance(chain: Chain, owner: Address, mint: Address): Promise<bigint> {
  const ata = await tokenAccountOf(owner, mint);
  const account = await chain.rpc.getAccountInfo(ata, { encoding: "base64" }).send();
  if (!account.value) return 0n;
  const balance = await chain.rpc.getTokenAccountBalance(ata).send();
  return BigInt(balance.value.amount);
}

/** Signs with `signer`, sends, waits for `confirmed` and returns the signature. */
export async function sendInstructions(chain: Chain, signer: KeyPairSigner, instructions: readonly Instruction[]): Promise<string> {
  await assertFork(chain.rpcUrl);
  const { value: blockhash } = await chain.rpc.getLatestBlockhash().send();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(signer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );
  const transaction = await signTransactionMessageWithSigners(message);
  assertIsTransactionWithBlockhashLifetime(transaction);
  await sendAndConfirmTransactionFactory(chain)(transaction, { commitment: "confirmed" });
  return getSignatureFromTransaction(transaction);
}

/**
 * What `owner`'s USDC balance would change by if these instructions ran now.
 * A simulation: no signature is made or checked, and nothing is sent.
 */
export async function simulateUsdcReceived(chain: Chain, owner: Address, instructions: readonly Instruction[]): Promise<bigint> {
  const usdcAccount = await tokenAccountOf(owner, USDC_MINT);
  const before = await tokenBalance(chain, owner, USDC_MINT);
  const { value: blockhash } = await chain.rpc.getLatestBlockhash().send();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(owner, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );
  const { value } = await chain.rpc
    .simulateTransaction(getBase64EncodedWireTransaction(compileTransaction(message)), {
      encoding: "base64",
      sigVerify: false,
      accounts: { addresses: [usdcAccount], encoding: "base64" },
    })
    .send();
  if (value.err) throw new Error(`simulating the withdrawal failed: ${JSON.stringify(value.err, (_key, v: unknown) => (typeof v === "bigint" ? v.toString() : v))}`);
  // Asked for as base64 and decoded here: Surfpool answers base64 whatever encoding is asked for.
  const data = value.accounts?.[0]?.data;
  if (!data) throw new Error("simulating the withdrawal returned no USDC account");
  const after = getTokenDecoder().decode(getBase64Encoder().encode(data[0])).amount;
  return after - before;
}

/** The network fee these instructions would cost `payer` in one transaction, in lamports. Nothing is signed or sent. */
export async function estimateFeeLamports(chain: Chain, payer: Address, instructions: readonly Instruction[]): Promise<bigint> {
  const { value: blockhash } = await chain.rpc.getLatestBlockhash().send();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(payer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );
  const encoded = getBase64Decoder().decode(getCompiledTransactionMessageEncoder().encode(compileTransactionMessage(message)));
  const { value } = await chain.rpc.getFeeForMessage(encoded as TransactionMessageBytesBase64).send();
  if (value === null) throw new Error("the RPC could not price the transaction");
  return value;
}

/** The rent a new token account for `mint` would cost `owner`, in lamports; zero when the account already exists. */
export async function newTokenAccountRentLamports(chain: Chain, owner: Address, mint: Address): Promise<bigint> {
  const account = await chain.rpc.getAccountInfo(await tokenAccountOf(owner, mint), { encoding: "base64" }).send();
  if (account.value) return 0n;
  return chain.rpc.getMinimumBalanceForRentExemption(BigInt(getTokenSize())).send();
}
