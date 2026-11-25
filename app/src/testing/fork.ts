// A Surfpool fork of mainnet with a funded test wallet. Used by the fork tests and by `pnpm run fork`.
import { type KeyPairSigner, createKeyPairSignerFromBytes } from "@solana/kit";
import { Surfnet } from "@solana/surfpool";
import { type Chain, connect } from "../chain.ts";
import { USDC_MINT } from "../config.ts";

export const PUBLIC_MAINNET_RPC = "https://api.mainnet-beta.solana.com";

/** How far ahead of the wall clock the fork starts. */
const CLOCK_LEAD_MS = 60_000;

export type Fork = {
  chain: Chain;
  wsUrl: string;
  surfnet: Surfnet;
  /** A new wallet with 1 SOL for fees and `usdc` base units of USDC, written into the fork's state. */
  newWallet: (usdc: bigint) => Promise<{ signer: KeyPairSigner; secretKey: number[] }>;
  /** Moves the fork's clock forward by about this many seconds (400 ms slots). */
  advanceSeconds: (seconds: number) => Promise<void>;
  stop: () => void;
};

export function startFork(remoteRpcUrl = process.env.MAINNET_RPC_URL || PUBLIC_MAINNET_RPC): Fork {
  // The fork fetches each mainnet account the first time it is touched, so an
  // account can arrive newer than the moment the fork started. With Surfpool's
  // default clock, which moves only when a transaction lands, a lender then
  // sees its own last update in the future and fails its interest arithmetic.
  // So: the clock runs in real time, and starts a minute ahead.
  const surfnet = Surfnet.startWithConfig({ offline: false, remoteRpcUrl, blockProductionMode: "clock", slotTimeMs: 400 });
  surfnet.timeTravelToTimestamp(Date.now() + CLOCK_LEAD_MS);
  const chain = connect(surfnet.rpcUrl, surfnet.wsUrl);
  return {
    chain,
    wsUrl: surfnet.wsUrl,
    surfnet,
    async newWallet(usdc) {
      const { secretKey } = Surfnet.newKeypair();
      const signer = await createKeyPairSignerFromBytes(new Uint8Array(secretKey));
      surfnet.fundSol(signer.address, 1_000_000_000);
      surfnet.fundToken(signer.address, USDC_MINT, Number(usdc));
      return { signer, secretKey };
    },
    async advanceSeconds(seconds) {
      const slot = await chain.rpc.getSlot().send();
      surfnet.timeTravelToSlot(Number(slot) + Math.ceil(seconds / 0.4));
    },
    stop: () => surfnet.stop(),
  };
}
