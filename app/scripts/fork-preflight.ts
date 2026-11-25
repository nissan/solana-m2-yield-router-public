// Before the fork tests: do the two outside services they need answer at all?
// A test run against one that does not answer hangs until its time limit and
// says nothing about why. This says which one, within seconds. Read-only.
import { jupiterApiFromEnv } from "../src/lenders/jupiter.ts";
import { PUBLIC_MAINNET_RPC } from "../src/testing/fork.ts";

const LIMIT_MS = 15_000;
const rpcUrl = process.env.MAINNET_RPC_URL || PUBLIC_MAINNET_RPC;
const jupiter = jupiterApiFromEnv();

async function answers(name: string, request: () => Promise<Response>): Promise<boolean> {
  const started = Date.now();
  try {
    const response = await request();
    if (response.ok) {
      console.log(`ok    ${name} answered in ${Date.now() - started} ms`);
      return true;
    }
    // Rate-limited is reachable: the service is there and the key was accepted. The run's own
    // requests wait out a limit once; stopping here would fail a run that was about to work.
    if (response.status === 429) {
      console.log(`ok    ${name} answered in ${Date.now() - started} ms, rate-limited for the moment (HTTP 429)`);
      return true;
    }
    console.error(`FAIL  ${name} answered HTTP ${response.status}`);
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    console.error(`FAIL  ${name} ${timedOut ? `did not answer within ${LIMIT_MS / 1000} s` : `could not be reached: ${error instanceof Error ? error.message : String(error)}`}`);
  }
  return false;
}

// Hosts only: an RPC address can carry its key in the path or the query.
const results = [
  await answers(`mainnet RPC (${new URL(rpcUrl).host}${process.env.MAINNET_RPC_URL ? ", from MAINNET_RPC_URL" : ", the public endpoint"})`, () =>
    fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getSlot" }),
      signal: AbortSignal.timeout(LIMIT_MS),
    }),
  ),
  await answers(`Jupiter Lend API (${new URL(jupiter.baseUrl).host}${jupiter.apiKey ? ", with JUPITER_API_KEY" : ", keyless"})`, () =>
    fetch(`${jupiter.baseUrl}/earn/tokens`, { headers: jupiter.apiKey ? { "x-api-key": jupiter.apiKey } : {}, signal: AbortSignal.timeout(LIMIT_MS) }),
  ),
];
if (results.includes(false)) {
  console.error("The fork tests were not started.");
  process.exitCode = 1;
}
