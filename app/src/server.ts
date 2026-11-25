// The page's server: the same router functions as the commands, over HTTP on
// this machine only. The test wallet's key stays here; the browser never sees it.
import { readFile } from "node:fs/promises";
import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";
import { extname, join, normalize, sep } from "node:path";
import type { KeyPairSigner } from "@solana/kit";
import { type Chain, tokenBalance } from "./chain.ts";
import { USDC_MINT } from "./config.ts";
import { type RateResult, RouterRefusal, chooseLender, parseUsdc } from "./rates.ts";
import type { Router } from "./router.ts";

export type AppOptions = {
  router: Router;
  chain: Chain;
  signer: KeyPairSigner;
  /** The built page. Without it only the API answers. */
  staticDir?: string;
  /** Present only on a fork this process started: moves its clock forward. */
  advanceSeconds?: (seconds: number) => Promise<void>;
};

/** How many readings the server remembers, so a deposit can act on the rates the page showed. */
const READINGS_KEPT = 20;
const BODY_LIMIT_BYTES = 10_000;
const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
};

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function send(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body, (_key, value: unknown) => (typeof value === "bigint" ? value.toString() : value));
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(text);
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  let text = "";
  for await (const chunk of request) {
    text += chunk;
    if (text.length > BODY_LIMIT_BYTES) throw new HttpError(413, "the request body is too large");
  }
  if (text === "") return {};
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new HttpError(400, "the request body is not JSON");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new HttpError(400, "the request body is not a JSON object");
  return body as Record<string, unknown>;
}

/**
 * A request that changes something must come from the page this server
 * served: JSON content type, and an Origin that is this server. Another site
 * open in the same browser can then not make the wallet deposit.
 */
function assertFromOwnPage(request: IncomingMessage): void {
  if (!(request.headers["content-type"] ?? "").startsWith("application/json")) throw new HttpError(415, "send JSON");
  const origin = request.headers.origin;
  if (!origin || new URL(origin).host !== request.headers.host) throw new HttpError(403, "this request did not come from the router's own page");
}

export function createApp(options: AppOptions): RequestListener {
  const { router, chain, signer } = options;
  const shown = new Map<string, RateResult[]>();
  let nextId = 1;

  function comparison(rates: RateResult[]) {
    try {
      return { higher: chooseLender(rates, router.now(), router.freshnessLimitMs).lender };
    } catch (error) {
      if (!(error instanceof RouterRefusal)) throw error;
      return { higher: null, refusal: { code: error.code, message: error.message, lender: error.lender ?? null } };
    }
  }

  async function api(request: IncomingMessage, path: string): Promise<unknown> {
    const route = `${request.method} ${path}`;
    switch (route) {
      case "GET /api/rates": {
        const rates = await router.readRates();
        const id = String(nextId++);
        shown.set(id, rates);
        if (shown.size > READINGS_KEPT) shown.delete(shown.keys().next().value!);
        return { id, rates, freshnessLimitMs: router.freshnessLimitMs, ...comparison(rates) };
      }
      case "GET /api/position":
        return {
          wallet: signer.address,
          usdc: await tokenBalance(chain, signer.address, USDC_MINT),
          positions: await router.positions(signer.address),
          canAdvanceClock: options.advanceSeconds !== undefined,
        };
      case "POST /api/deposit": {
        assertFromOwnPage(request);
        const body = await readJson(request);
        if (typeof body.amount !== "string") throw new HttpError(400, "amount must be a string of USDC, such as \"100\"");
        if (typeof body.ratesId !== "string") throw new HttpError(400, "ratesId must name the rates the page showed");
        const amount = parseUsdc(body.amount);
        const rates = shown.get(body.ratesId);
        if (!rates) throw new RouterRefusal("RATE_STALE", "the rates on the page are no longer held by the server; read them again");
        const result = await router.deposit(signer, amount, rates);
        return { lender: result.chosen.lender, amount: result.amount, signature: result.signature };
      }
      case "POST /api/withdraw":
        assertFromOwnPage(request);
        return { withdrawals: await router.withdrawAll(signer) };
      case "POST /api/fork/advance-day":
        assertFromOwnPage(request);
        if (!options.advanceSeconds) throw new HttpError(404, "this server did not start the fork, so it cannot move its clock");
        await options.advanceSeconds(86_400);
        return { advancedSeconds: 86_400 };
    }
    throw new HttpError(path.startsWith("/api/") ? 404 : 405, `no such route: ${route}`);
  }

  async function file(path: string, response: ServerResponse): Promise<void> {
    if (!options.staticDir) throw new HttpError(404, "the page has not been built: run pnpm run build");
    const relative = normalize(path === "/" ? "/index.html" : path);
    const full = join(options.staticDir, relative);
    if (!full.startsWith(options.staticDir + sep)) throw new HttpError(404, "not found");
    let data: Buffer;
    try {
      data = await readFile(full);
    } catch {
      throw new HttpError(404, "not found");
    }
    response.writeHead(200, { "content-type": CONTENT_TYPES[extname(full)] ?? "application/octet-stream" });
    response.end(data);
  }

  return (request, response) => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    const handled =
      path.startsWith("/api/") || request.method !== "GET" ? api(request, path).then((body) => send(response, 200, body)) : file(path, response);
    handled.catch((error: unknown) => {
      if (error instanceof RouterRefusal) {
        // Understood and declined: nothing was signed or sent.
        send(response, 409, { refusal: { code: error.code, message: error.message, lender: error.lender ?? null } });
      } else if (error instanceof HttpError) {
        send(response, error.status, { error: error.message });
      } else {
        send(response, 500, { error: error instanceof Error ? error.message : String(error) });
      }
    });
  };
}

/** What the page's requests return, for the page's own types. */
export type RatesResponse = {
  id: string;
  rates: (Omit<Extract<RateResult, { ratePercent: number }>, "readAt"> & { readAt: string } | Extract<RateResult, { error: string }>)[];
  freshnessLimitMs: number;
  higher: "kamino" | "jupiter" | null;
  refusal?: Refusal;
};
export type Refusal = { code: string; message: string; lender: "kamino" | "jupiter" | null };
export type PositionResponse = {
  wallet: string;
  usdc: string;
  positions: { lender: "kamino" | "jupiter"; shares: string; usdc: string }[];
  canAdvanceClock: boolean;
};
export type DepositResponse = { lender: "kamino" | "jupiter"; amount: string; signature: string };
export type WithdrawResponse = { withdrawals: { lender: "kamino" | "jupiter"; signature: string; usdcReceived: string }[] };
