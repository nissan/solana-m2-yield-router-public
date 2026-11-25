# Stablecoin yield router on Solana

Reads the USDC supply rate at two lenders on Solana, Kamino and Jupiter Lend, puts USDC with whichever pays more, shows the position, and takes it all back out. A fifth command says whether moving to the other lender would pay for itself. It runs on a fork of Solana mainnet on your own machine, with a test wallet that exists nowhere else. It has never moved real money, and it refuses to sign anywhere but a local fork.

This is Deed #7 of The Solana Deeds, a series of one-day learning builds.

It has a [write-up](https://reddi.tech/blog/solana-m2-yield-router) and a [demo](https://youtu.be/hgayP3aIwbA), about five minutes.

This is a source snapshot of `03041dc378da0c0f9dde195d610c3d6a3520a3a5`. The private build journal, issue history, evidence files and hosted checks are not part of this repository. Test names and a few comments carry labels such as `M2-002` or `M2-007-S1`: those are outcome and scenario numbers from that private history. Built and reviewed by an AI agent session directed by the author; no independent review.

## What was built

- **Compare.** Reads both lenders' USDC rate and shows each with where it came from and when it was read. Both are simple yearly rates (APR) including rewards, so they are the same kind of number.
- **Deposit.** Puts the USDC with whichever reads higher. If either rate could not be read, or was read more than 60 seconds ago, it refuses and says which.
- **Position and withdraw.** What the wallet holds at the lender, and all of it back out.
- **Advice.** Whether the other lender's higher rate would pay back the cost of moving (network fees, and rent for a new token account) within a number of days. It moves nothing.
- **A page in the browser** for the first three, usable from the keyboard alone, built with [UI SDK](https://ui-sdk.dev/). Its server listens on `127.0.0.1` only and keeps the test wallet's key.
- **Checks before signing.** Every path that signs first asks the RPC a question only a local [Surfpool](https://www.npmjs.com/package/@solana/surfpool) fork answers. Instructions returned by Jupiter's API are checked against what was asked for (one instruction, the right program and instruction, the amount, the wallet as the only signer, the wallet's own token accounts) before the wallet signs them.

## Run it

Install [mise](https://mise.jdx.dev), which installs the pinned Node and pnpm from `mise.toml`. Linux x64 (glibc) or macOS: the fork runtime ships prebuilt for those only. The install is about 560 MB.

```sh
mise install
cd app
export PATH="$(mise where node)/bin:$(mise where pnpm):$PATH"
pnpm install --frozen-lockfile
pnpm run ci
```

This typechecks, builds the commands and the page, and runs 152 tests. They make no network call. The project refuses any Node other than 22.x, which is why the `PATH` line is there.

**The whole thing, against the real lenders:**

```sh
pnpm run reproduce
```

It starts a fork of mainnet, makes a wallet with 100 USDC, then compares the two rates, shows a deposit refused because the rates are too old, deposits with the higher lender, asks for advice, moves the fork's clock forward a day, withdraws, and checks the wallet got at least its 100 USDC back. It prints `PASS` or `FAIL` beside each of nine checks and exits 0 only if all held. It needs no key and no account: it reads mainnet through the public RPC and Jupiter's keyless API, which both rate-limit.

**In the browser:**

```sh
pnpm run build
pnpm run demo
```

It prints an address on your machine to open. A button on the page moves the fork's clock forward a day, which is how a day of interest is seen.

**From the terminal:** `pnpm run fork` starts a fork with a test wallet and prints three `export` lines; in a second terminal in `app/`, after those lines, `pnpm run router compare`, `deposit 100`, `position`, `withdraw` and `recommend`.

| Variable | For | Default |
|---|---|---|
| `MAINNET_RPC_URL` | the mainnet RPC the fork reads from | the public endpoint, which rate-limits |
| `JUPITER_API_KEY` | Jupiter's keyed API, ten requests in ten seconds | the keyless host, five in ten seconds |

`pnpm run test:fork` runs the 19 tests that need the fork and the network.

## How it works

- **The fork.** Surfpool runs a local Solana validator that fetches each mainnet account the first time anything asks for it. The lenders' real programs run on it. A cheatcode writes the test wallet's balance; time travel moves the clock forward. Transactions go to the fork only.
- **Kamino's rate** is the main market's USDC reserve's supply APR plus its reserve-rewards APR, from on-chain state through the Kamino SDK. The reserve is read by address and checked to be the market's and for the USDC mint.
- **Jupiter Lend's rate** is `supplyRate` plus `rewardsRate` from its API, checked against its own `totalRate`.
- **The position** is the lender's own token in the wallet. Nothing is held by this code.
- **Dry runs.** The value of a Jupiter position is read by simulating a full withdrawal on the fork.

## Known limitations

- **A fork, not mainnet.** There is no path here for anyone to make a real deposit, and no wallet connection.
- **Jupiter Lend's deposit earned about 1.2 to 1.4% less than its published rate** over a day on the fork, in every run; Kamino's matched its rate. The cause was not established.
- **Jupiter's rate is mainnet's**, from its API; Kamino's is the fork's state.
- **Rounding.** Both lenders round in their own favour: a same-minute withdrawal returns a few millionths of a dollar less than went in, and a Kamino deposit can leave one base unit in the wallet.
- **The advice** assumes today's rates hold, uses simple interest, and counts the new account's rent as lost. It is arithmetic, not financial advice.
- **Four dependency advisories are open**, all under the Kamino SDK: `bigint-buffer` (no patched version; its native binding is not built here) and `stream-json` (its patched line breaks `jayson`'s server, which nothing here loads).
- **UI SDK is a beta**, pinned exactly.

## Licence

MIT. See [LICENSE](LICENSE).
