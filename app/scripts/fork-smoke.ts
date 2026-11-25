// Toolchain smoke for the mainnet fork (M2-001): start Surfpool as a fork of
// mainnet and read two real accounts through it with kit. Read-only; signs and
// sends nothing. Not part of `pnpm run ci`, because it needs a mainnet RPC.
//
//   MAINNET_RPC_URL=<your provider> pnpm run fork:smoke
import { PROGRAM_ID as KAMINO_LEND_PROGRAM } from "@kamino-finance/klend-sdk";
import { createSolanaRpc } from "@solana/kit";
import { Surfnet } from "@solana/surfpool";
import { USDC_MINT } from "../src/config.ts";

const remoteRpcUrl = process.env.MAINNET_RPC_URL || "https://api.mainnet-beta.solana.com";
const surfnet = Surfnet.startWithConfig({ offline: false, remoteRpcUrl });
try {
  const rpc = createSolanaRpc(surfnet.rpcUrl);
  const mint = await rpc.getAccountInfo(USDC_MINT, { encoding: "jsonParsed" }).send();
  const data = mint.value?.data;
  if (!data || !("parsed" in data)) throw new Error("the fork did not return the USDC mint");
  const info = data.parsed.info as { decimals: number; supply: string };
  if (info.decimals !== 6) throw new Error(`USDC decimals read ${info.decimals}, expected 6`);
  const program = await rpc.getAccountInfo(KAMINO_LEND_PROGRAM, { encoding: "base64" }).send();
  if (!program.value?.executable) throw new Error("the fork did not return the Kamino Lend program");
  console.log(`fork of mainnet at ${surfnet.rpcUrl}`);
  console.log(`USDC mint ${USDC_MINT}: decimals ${info.decimals}, supply ${info.supply} base units`);
  console.log(`Kamino Lend ${KAMINO_LEND_PROGRAM}: executable, owner ${program.value.owner}`);
} finally {
  surfnet.stop();
}
