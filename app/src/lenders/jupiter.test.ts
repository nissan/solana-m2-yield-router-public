import { generateKeyPairSigner } from "@solana/kit";
import { describe, expect, test } from "vitest";
import { USDC_MINT } from "../config.ts";
import { realAnswer } from "./fixtures/answers.ts";
import { type JupiterApi, jupiterApiFromEnv, jupiterDepositInstructions, readJupiterRate } from "./jupiter.ts";

const NOW = new Date("2026-11-24T08:00:00.000Z");
const JL_USDC = "9BEcn9aPEmhSPbPQeFGjidRiEKki46fVQDyPpSQXPA2D";
const usdcMarket = { address: JL_USDC, assetAddress: USDC_MINT, supplyRate: "415", rewardsRate: "25", totalRate: "440", convertToAssets: "1070813" };
const otherMarket = { address: "2uQsyo1fXXQkDtcpXnLofWy88PxcvnfH2L8FPSE62FVU", assetAddress: "So11111111111111111111111111111111111111112", totalRate: "999", convertToAssets: "1" };

/** An API that answers each request with the next canned response, and records what was asked and waited. */
function api(...responses: (() => Response)[]) {
  const requests: string[] = [];
  const sleeps: number[] = [];
  const fake: JupiterApi = {
    baseUrl: "https://jup.example/lend/v1",
    fetch: async (input) => {
      requests.push(String(input));
      const next = responses.shift();
      if (!next) throw new Error("the test API was asked more often than it was told to answer");
      return next();
    },
    sleep: async (ms) => void sleeps.push(ms),
  };
  return { fake, requests, sleeps };
}
const json = (body: unknown) => () => Response.json(body);
const limited = (resetInSeconds: number | null) => () =>
  new Response("slow down", { status: 429, headers: resetInSeconds === null ? {} : { "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + resetInSeconds) } });

describe("reading Jupiter Lend's USDC rate", () => {
  test("the USDC market's total rate, found by mint, with its source and read time", async () => {
    const { fake, requests } = api(json([otherMarket, usdcMarket]));
    expect(await readJupiterRate(fake, () => NOW)).toEqual({
      lender: "jupiter",
      ratePercent: 4.4,
      source: `https://jup.example/lend/v1/earn/tokens (supply APR 4.150% + rewards APR 0.250%, market ${JL_USDC})`,
      readAt: NOW,
    });
    expect(requests).toEqual(["https://jup.example/lend/v1/earn/tokens"]);
  });

  test.each([
    ["an HTTP error", () => new Response("down", { status: 503 }), "answered HTTP 503"],
    ["no USDC market in the list", json([otherMarket]), "lists no market for mint"],
    ["something that is not a list", json({ error: "nope" }), "did not return a list"],
    ["a market without a rate", json([{ address: JL_USDC, assetAddress: USDC_MINT, convertToAssets: "1" }]), "without address, totalRate or convertToAssets"],
    ["a rate that is not a whole number", json([{ ...usdcMarket, totalRate: "4.4%" }]), "not three whole numbers"],
    ["a total that is not supply plus rewards", json([{ ...usdcMarket, totalRate: "500" }]), "a totalRate of 500 that is not supplyRate 415 plus rewardsRate 25"],
  ])("%s is an error that says what was wrong", async (_name, response, message) => {
    await expect(readJupiterRate(api(response).fake, () => NOW)).rejects.toThrow(message);
  });
});

describe("the API's rate limit", () => {
  test("a 429 that names a reset a few seconds away is waited out and asked once more", async () => {
    const { fake, requests, sleeps } = api(limited(3), json([usdcMarket]));
    expect((await readJupiterRate(fake, () => NOW)).ratePercent).toBe(4.4);
    expect(requests).toHaveLength(2);
    expect(sleeps).toHaveLength(1);
    expect(sleeps[0]).toBeGreaterThan(2_000);
    expect(sleeps[0]).toBeLessThanOrEqual(4_500);
  });

  // The hosted fork job met two 429s in a row on the keyed host, where one wait used to be all.
  test("a second 429 is waited out too; three in a row are an error, not a fourth request", async () => {
    const twice = api(limited(3), limited(3), json([usdcMarket]));
    expect((await readJupiterRate(twice.fake, () => NOW)).ratePercent).toBe(4.4);
    expect(twice.requests).toHaveLength(3);
    const thrice = api(limited(3), limited(3), limited(3));
    await expect(readJupiterRate(thrice.fake, () => NOW)).rejects.toThrow("answered HTTP 429 (rate limited)");
    expect(thrice.requests).toHaveLength(3);
  });

  test.each([
    ["no reset time", null],
    ["a reset a minute away", 60],
    ["a reset in the past", -30],
  ])("a 429 with %s is an error at once, without waiting", async (_name, reset) => {
    const { fake, requests, sleeps } = api(limited(reset));
    await expect(readJupiterRate(fake, () => NOW)).rejects.toThrow("answered HTTP 429");
    expect([requests.length, sleeps.length]).toEqual([1, 0]);
  });

  test("an answer that says none are left makes the next request wait for the window, instead of meeting a 429", async () => {
    const last = () =>
      Response.json([usdcMarket], { headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 3) } });
    const { fake, requests, sleeps } = api(last, json([usdcMarket]));
    await readJupiterRate(fake, () => NOW);
    expect(sleeps).toEqual([]);
    await readJupiterRate(fake, () => NOW);
    expect(requests).toHaveLength(2);
    expect(sleeps).toHaveLength(1);
    expect(sleeps[0]).toBeGreaterThan(2_000);
  });

  test("the reset is measured on the server's clock, so a machine five minutes ahead still waits", async () => {
    const serverNow = Date.now() - 300_000;
    const skewed = () =>
      new Response("slow down", {
        status: 429,
        headers: { date: new Date(serverNow).toUTCString(), "x-ratelimit-reset": String(Math.floor(serverNow / 1000) + 4) },
      });
    const { fake, sleeps } = api(skewed, json([usdcMarket]));
    await readJupiterRate(fake, () => NOW);
    expect(sleeps).toHaveLength(1);
    expect(sleeps[0]).toBeGreaterThan(2_000);
  });

  test("requests through one API object go one at a time", async () => {
    let inFlight = 0;
    let most = 0;
    const { fake } = api(json([usdcMarket]), json([usdcMarket]), json([usdcMarket]));
    const inner = fake.fetch;
    fake.fetch = async (input, init) => {
      most = Math.max(most, ++inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
      return inner(input, init);
    };
    await Promise.all([readJupiterRate(fake, () => NOW), readJupiterRate(fake, () => NOW), readJupiterRate(fake, () => NOW)]);
    expect(most).toBe(1);
  });
});

describe("building a deposit", () => {
  test("creates the jlUSDC account first, then the API's instruction, asking for the exact amount and signer", async () => {
    const owner = await generateKeyPairSigner();
    const bodies: unknown[] = [];
    const { fake, requests } = api(json({ instructions: await realAnswer("deposit", owner.address, 12_500_000n) }));
    const inner = fake.fetch;
    fake.fetch = async (input, init) => {
      if (init?.body) bodies.push(JSON.parse(String(init.body)));
      return inner(input, init);
    };
    const instructions = await jupiterDepositInstructions(fake, owner, 12_500_000n);
    expect(instructions.map((i) => i.programAddress)).toEqual(["ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL", "jup3YeL8QhtSx1e253b2FDvsMNC87fDrgQZivbrndc9"]);
    expect(bodies).toEqual([{ asset: USDC_MINT, amount: "12500000", signer: owner.address }]);
    // The jlUSDC mint is a constant, so a deposit costs one request, not two.
    expect(requests).toEqual(["https://jup.example/lend/v1/earn/deposit-instructions"]);
  });

  test("an answer the router did not ask for is refused before anything is built", async () => {
    const owner = await generateKeyPairSigner();
    await expect(jupiterDepositInstructions(api(json({ instructions: await realAnswer("deposit", owner.address, 1n) })).fake, owner, 2n)).rejects.toThrow(
      "an amount of 1 where 2 was asked for",
    );
  });

  test("a token list that names another share token for USDC is an error", async () => {
    await expect(readJupiterRate(api(json([{ ...usdcMarket, address: "2uQsyo1fXXQkDtcpXnLofWy88PxcvnfH2L8FPSE62FVU" }])).fake, () => NOW)).rejects.toThrow("not jlUSDC");
  });
});

describe("an API key", () => {
  const KEY = "jup_test_key_not_real";

  test("JUPITER_API_KEY selects the keyed host; without it, or with it blank, the keyless one", () => {
    expect(jupiterApiFromEnv({ JUPITER_API_KEY: ` ${KEY}\n` })).toMatchObject({ baseUrl: "https://api.jup.ag/lend/v1", apiKey: KEY });
    expect(jupiterApiFromEnv({})).toMatchObject({ baseUrl: "https://lite-api.jup.ag/lend/v1" });
    expect(jupiterApiFromEnv({ JUPITER_API_KEY: "  " }).apiKey).toBeUndefined();
    // The same object each time, so all its users share one pacer.
    expect(jupiterApiFromEnv({ JUPITER_API_KEY: KEY })).toBe(jupiterApiFromEnv({ JUPITER_API_KEY: ` ${KEY} ` }));
    expect(jupiterApiFromEnv({})).toBe(jupiterApiFromEnv({ JUPITER_API_KEY: "" }));
  });

  test("the key goes in the x-api-key header of every request, including the one after a 429", async () => {
    const seen: (string | undefined)[] = [];
    const { fake } = api(limited(3), json([usdcMarket]));
    const inner = fake.fetch;
    fake.apiKey = KEY;
    fake.fetch = async (input, init) => {
      seen.push((init?.headers as Record<string, string> | undefined)?.["x-api-key"]);
      return inner(input, init);
    };
    await readJupiterRate(fake, () => NOW);
    expect(seen).toEqual([KEY, KEY]);
  });

  test("the key is in neither the reading's source nor an error's message", async () => {
    const ok = api(json([usdcMarket])).fake;
    ok.apiKey = KEY;
    expect(JSON.stringify(await readJupiterRate(ok, () => NOW))).not.toContain(KEY);
    const down = api(() => new Response(`bad key ${KEY}`, { status: 401 })).fake;
    down.apiKey = KEY;
    const error = await readJupiterRate(down, () => NOW).catch((e: Error) => e);
    expect((error as Error).message).toBe("https://jup.example/lend/v1/earn/tokens answered HTTP 401");
  });
});

describe("rates are never remembered", () => {
  test("a rate is read from the API every time", async () => {
    const { fake, requests } = api(json([usdcMarket]), json([{ ...usdcMarket, supplyRate: "485", totalRate: "510" }]));
    expect((await readJupiterRate(fake, () => NOW)).ratePercent).toBe(4.4);
    expect((await readJupiterRate(fake, () => NOW)).ratePercent).toBe(5.1);
    expect(requests).toHaveLength(2);
  });
});
