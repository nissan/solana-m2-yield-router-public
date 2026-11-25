// The page's side of the server's API. A refusal is a result, not an exception:
// the page shows it. Anything else that goes wrong is thrown.
import type { DepositResponse, PositionResponse, RatesResponse, Refusal, WithdrawResponse } from "../src/server.ts";

export type { DepositResponse, PositionResponse, RatesResponse, Refusal, WithdrawResponse };
export type Refused = { refusal: Refusal };

export type Api = {
  rates: () => Promise<RatesResponse>;
  position: () => Promise<PositionResponse>;
  deposit: (amount: string, ratesId: string) => Promise<DepositResponse | Refused>;
  withdraw: () => Promise<WithdrawResponse | Refused>;
  advanceDay: () => Promise<void>;
};

export function isRefused(result: object): result is Refused {
  return "refusal" in result;
}

async function call<T>(path: string, body?: object): Promise<T | Refused> {
  const response = await fetch(path, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : undefined);
  const result = (await response.json()) as T | Refused | { error: string };
  if (response.status === 409 && "refusal" in (result as object)) return result as Refused;
  if (!response.ok) throw new Error("error" in (result as object) ? (result as { error: string }).error : `the server answered HTTP ${response.status}`);
  return result as T;
}

export const httpApi: Api = {
  rates: () => call<RatesResponse>("/api/rates") as Promise<RatesResponse>,
  position: () => call<PositionResponse>("/api/position") as Promise<PositionResponse>,
  deposit: (amount, ratesId) => call<DepositResponse>("/api/deposit", { amount, ratesId }),
  withdraw: () => call<WithdrawResponse>("/api/withdraw", {}),
  advanceDay: async () => void (await call("/api/fork/advance-day", {})),
};
