import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSigner } from "@solana/kit";
import { Surfnet } from "@solana/surfpool";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { connect } from "./chain.ts";
import { listen } from "./listen.ts";
import { type RateResult, RouterRefusal, chooseLender } from "./rates.ts";
import type { Router } from "./router.ts";
import { type AppOptions, createApp } from "./server.ts";

// An offline runtime stands in for the fork: real RPC for balances, no lenders on it.
let surfnet: Surfnet;
let staticDir: string;
beforeAll(async () => {
  surfnet = Surfnet.start();
  staticDir = await mkdtemp(join(tmpdir(), "yield-router-page-"));
  await writeFile(join(staticDir, "index.html"), "<!doctype html><title>page</title>");
});
afterAll(() => surfnet.stop());

const servers: Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) {
    server.close();
    server.closeAllConnections();
  }
});

async function start(overrides: Partial<Router> = {}, options: Partial<AppOptions> = {}) {
  let clock = Date.parse("2026-11-24T08:00:00.000Z");
  const rates = (): RateResult[] => [
    { lender: "kamino", ratePercent: 3.97, source: "Kamino reserve D6q6 (slot 1)", readAt: new Date(clock) },
    { lender: "jupiter", ratePercent: 4.4, source: "https://jup.example/earn/tokens", readAt: new Date(clock) },
  ];
  const calls: string[] = [];
  const router: Router = {
    readRates: async () => rates(),
    // The real freshness rule, so the server's handling of it is what is tested.
    deposit: async (_owner, amount, used) => {
      const chosen = chooseLender(used ?? [], new Date(clock), 60_000);
      calls.push(`deposit ${amount} with ${chosen.lender}`);
      return { chosen, rates: used ?? [], amount, signature: "SIG" };
    },
    positions: async () => [{ lender: "jupiter", shares: 93_386_371n, usdc: 100_000_000n }],
    withdrawAll: async () => (calls.push("withdraw"), [{ lender: "jupiter", signature: "SIG2", usdcReceived: 100_012_087n }]),
    recommend: async () => [],
    now: () => new Date(clock),
    freshnessLimitMs: 60_000,
    ...overrides,
  };
  const chain = connect(surfnet.rpcUrl, surfnet.wsUrl);
  const signer = await generateKeyPairSigner();
  const { server, url } = await listen(createApp({ router, chain, signer, staticDir, ...options }), 0);
  servers.push(server);
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(url + path, { method: "POST", headers: { "content-type": "application/json", origin: url, ...headers }, body: JSON.stringify(body) });
  return { url, post, calls, signer, advance: (ms: number) => void (clock += ms) };
}

describe("reading", () => {
  test("GET /api/rates returns both rates with source and read time, the higher lender, and an id for a later deposit", async () => {
    const { url } = await start();
    const body = await (await fetch(`${url}/api/rates`)).json();
    expect(body).toEqual({
      id: "1",
      freshnessLimitMs: 60_000,
      higher: "jupiter",
      rates: [
        { lender: "kamino", ratePercent: 3.97, source: "Kamino reserve D6q6 (slot 1)", readAt: "2026-11-24T08:00:00.000Z" },
        { lender: "jupiter", ratePercent: 4.4, source: "https://jup.example/earn/tokens", readAt: "2026-11-24T08:00:00.000Z" },
      ],
    });
  });

  test("with one rate unreadable it still returns the other, no higher lender, and the refusal a deposit would get", async () => {
    const { url } = await start({ readRates: async () => [{ lender: "kamino", error: "RPC timed out" }, { lender: "jupiter", ratePercent: 4.4, source: "s", readAt: new Date() }] });
    const body = (await (await fetch(`${url}/api/rates`)).json()) as { higher: unknown; refusal: unknown };
    expect(body.higher).toBeNull();
    expect(body.refusal).toEqual({ code: "RATE_MISSING", message: "Kamino's rate could not be read: RPC timed out", lender: "kamino" });
  });

  test("GET /api/position returns the wallet, its USDC and its positions, with amounts as text", async () => {
    const { url, signer } = await start();
    expect(await (await fetch(`${url}/api/position`)).json()).toEqual({
      wallet: signer.address,
      usdc: "0",
      positions: [{ lender: "jupiter", shares: "93386371", usdc: "100000000" }],
      canAdvanceClock: false,
    });
  });
});

describe("POST /api/deposit", () => {
  test("deposits the amount using the rates the page was shown", async () => {
    const { url, post, calls } = await start();
    const { id } = (await (await fetch(`${url}/api/rates`)).json()) as { id: string };
    const response = await post("/api/deposit", { amount: "12.5", ratesId: id });
    expect([response.status, await response.json()]).toEqual([200, { lender: "jupiter", amount: "12500000", signature: "SIG" }]);
    expect(calls).toEqual(["deposit 12500000 with jupiter"]);
  });

  test("S3: rates shown more than the limit ago are refused with 409, naming the stale input; nothing is deposited", async () => {
    const { url, post, calls, advance } = await start();
    const { id } = (await (await fetch(`${url}/api/rates`)).json()) as { id: string };
    advance(75_000);
    const response = await post("/api/deposit", { amount: "100", ratesId: id });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ refusal: { code: "RATE_STALE", message: "Kamino's rate is stale: read 75s ago, the limit is 60s", lender: "kamino" } });
    expect(calls).toEqual([]);
  });

  test("S3: a deposit against rates with one missing is refused, naming the missing input", async () => {
    const { url, post, calls } = await start({ readRates: async () => [{ lender: "kamino", ratePercent: 3.97, source: "s", readAt: new Date("2026-11-24T08:00:00.000Z") }, { lender: "jupiter", error: "HTTP 503" }] });
    const { id } = (await (await fetch(`${url}/api/rates`)).json()) as { id: string };
    const response = await post("/api/deposit", { amount: "100", ratesId: id });
    expect([response.status, ((await response.json()) as { refusal: { code: string; lender: string } }).refusal.lender]).toEqual([409, "jupiter"]);
    expect(calls).toEqual([]);
  });

  test("the page cannot supply its own rates: an id the server never issued is refused", async () => {
    const { post, calls } = await start();
    const response = await post("/api/deposit", { amount: "100", ratesId: "999", rates: [{ lender: "kamino", ratePercent: 99 }] });
    expect(response.status).toBe(409);
    expect(((await response.json()) as { refusal: { code: string } }).refusal.code).toBe("RATE_STALE");
    expect(calls).toEqual([]);
  });

  test.each([
    ["a bad amount", { amount: "ten", ratesId: "1" }, 409, "BAD_AMOUNT"],
    ["an amount that is a number, not text", { amount: 100, ratesId: "1" }, 400, undefined],
    ["no rates id", { amount: "100" }, 400, undefined],
  ])("%s is rejected before the router is asked", async (_name, body, status, code) => {
    const { post, calls } = await start();
    const response = await post("/api/deposit", body);
    expect(response.status).toBe(status);
    expect(((await response.json()) as { refusal?: { code: string } }).refusal?.code).toBe(code);
    expect(calls).toEqual([]);
  });

  test("a router refusal such as too little USDC comes back as 409 with its message", async () => {
    const { url, post } = await start({
      deposit: async () => {
        throw new RouterRefusal("INSUFFICIENT_USDC", "the wallet holds 100.000000 USDC, less than the 1000.000000 asked for");
      },
    });
    const { id } = (await (await fetch(`${url}/api/rates`)).json()) as { id: string };
    const response = await post("/api/deposit", { amount: "1000", ratesId: id });
    expect([response.status, ((await response.json()) as { refusal: { code: string } }).refusal.code]).toEqual([409, "INSUFFICIENT_USDC"]);
  });

  test("a failure that is not a refusal is a 500 with the message, not a refusal", async () => {
    const { url, post } = await start({
      deposit: async () => {
        throw new Error("Transaction simulation failed");
      },
    });
    const { id } = (await (await fetch(`${url}/api/rates`)).json()) as { id: string };
    const response = await post("/api/deposit", { amount: "1", ratesId: id });
    expect([response.status, await response.json()]).toEqual([500, { error: "Transaction simulation failed" }]);
  });
});

describe("only the router's own page can make the wallet act", () => {
  test.each(["/api/deposit", "/api/withdraw", "/api/fork/advance-day"])("POST %s from another site's origin is refused with 403", async (path) => {
    const { post, calls } = await start({}, { advanceSeconds: async () => void calls.push("advance") });
    const response = await post(path, { amount: "100", ratesId: "1" }, { origin: "https://evil.example" });
    expect(response.status).toBe(403);
    expect(calls).toEqual([]);
  });

  test("a POST with no Origin, or one that is not JSON, is refused", async () => {
    const { url, calls } = await start();
    const noOrigin = await fetch(`${url}/api/withdraw`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    const form = await fetch(`${url}/api/withdraw`, { method: "POST", headers: { "content-type": "text/plain", origin: url }, body: "{}" });
    expect([noOrigin.status, form.status]).toEqual([403, 415]);
    expect(calls).toEqual([]);
  });

  test("the server listens on 127.0.0.1 only", async () => {
    await start();
    expect((servers.at(-1)!.address() as AddressInfo).address).toBe("127.0.0.1");
  });
});

describe("withdraw, the fork's clock, and the page's files", () => {
  test("POST /api/withdraw returns what came back from where", async () => {
    const { post } = await start();
    expect(await (await post("/api/withdraw", {})).json()).toEqual({ withdrawals: [{ lender: "jupiter", signature: "SIG2", usdcReceived: "100012087" }] });
  });

  test("the clock can be moved only when this process started the fork", async () => {
    const without = await start();
    expect((await without.post("/api/fork/advance-day", {})).status).toBe(404);
    const moved: number[] = [];
    const withFork = await start({}, { advanceSeconds: async (s) => void moved.push(s) });
    expect((await withFork.post("/api/fork/advance-day", {})).status).toBe(200);
    expect(moved).toEqual([86_400]);
    expect(((await (await fetch(`${withFork.url}/api/position`)).json()) as { canAdvanceClock: boolean }).canAdvanceClock).toBe(true);
  });

  test("serves the built page, and nothing outside its folder", async () => {
    const { url } = await start();
    const page = await fetch(`${url}/`);
    expect([page.status, page.headers.get("content-type"), await page.text()]).toEqual([200, "text/html; charset=utf-8", "<!doctype html><title>page</title>"]);
    expect((await fetch(`${url}/missing.js`)).status).toBe(404);
    expect((await fetch(`${url}/..%2f..%2f..%2fetc%2fpasswd`)).status).toBe(404);
    expect((await fetch(`${url}/api/nothing`)).status).toBe(404);
  });
});
