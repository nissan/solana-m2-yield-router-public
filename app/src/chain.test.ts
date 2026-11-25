import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { generateKeyPairSigner } from "@solana/kit";
import { Surfnet } from "@solana/surfpool";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { assertFork, connect, sendInstructions } from "./chain.ts";
import { RouterRefusal } from "./rates.ts";

// A local JSON-RPC server that is not Surfpool: it does not know surfnet_getSurfnetInfo, as a real validator would not.
let notSurfpool: Server;
let notSurfpoolUrl: string;
const methodsAsked: string[] = [];
beforeAll(async () => {
  notSurfpool = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    methodsAsked.push((JSON.parse(body) as { method: string }).method);
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32601, message: "Method not found" } }));
  });
  await new Promise<void>((resolve) => notSurfpool.listen(0, "127.0.0.1", resolve));
  notSurfpoolUrl = `http://127.0.0.1:${(notSurfpool.address() as AddressInfo).port}`;
});
afterAll(() => void notSurfpool.close());

async function refusalOf(promise: Promise<unknown>): Promise<RouterRefusal> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof RouterRefusal) return error;
    throw error;
  }
  throw new Error("expected a refusal, and nothing was refused");
}

describe("the guard every signing path passes through", () => {
  test("a Surfpool runtime on this machine passes", async () => {
    const surfnet = Surfnet.start();
    try {
      await expect(assertFork(surfnet.rpcUrl)).resolves.toBeUndefined();
    } finally {
      surfnet.stop();
    }
  });

  test.each(["https://api.mainnet-beta.solana.com", "https://mainnet.helius-rpc.com/?api-key=x", "http://192.168.1.10:8899"])(
    "%s is refused without being contacted",
    async (url) => {
      let contacted = false;
      const error = await refusalOf(
        assertFork(url, async () => {
          contacted = true;
          return Response.json({ result: {} });
        }),
      );
      expect(error.code).toBe("NOT_A_FORK");
      expect(contacted).toBe(false);
    },
  );

  test("a local RPC that is not Surfpool is refused", async () => {
    expect((await refusalOf(assertFork(notSurfpoolUrl))).code).toBe("NOT_A_FORK");
  });

  test("sending stops at the guard: a local RPC that is not Surfpool is asked nothing else, and nothing is signed", async () => {
    methodsAsked.length = 0;
    const chain = connect(notSurfpoolUrl, notSurfpoolUrl.replace("http", "ws"));
    const signer = await generateKeyPairSigner();
    expect((await refusalOf(sendInstructions(chain, signer, []))).code).toBe("NOT_A_FORK");
    expect(methodsAsked).toEqual(["surfnet_getSurfnetInfo"]);
  });

  test("a local address nothing listens on is refused", async () => {
    notSurfpool.close();
    expect((await refusalOf(assertFork(notSurfpoolUrl))).code).toBe("NOT_A_FORK");
  });
});
