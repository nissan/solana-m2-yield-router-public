// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test, vi } from "vitest";
import { App } from "./App.tsx";
import type { Api, PositionResponse, RatesResponse } from "./api.ts";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const T0 = Date.parse("2026-11-24T08:00:00.000Z");
const ratesAt = (ms: number, id = "1"): RatesResponse => ({
  id,
  freshnessLimitMs: 60_000,
  higher: "jupiter",
  rates: [
    { lender: "kamino", ratePercent: 3.9694, source: "Kamino reserve D6q6 (slot 1)", readAt: new Date(ms).toISOString() },
    { lender: "jupiter", ratePercent: 4.4, source: "https://jup.example/earn/tokens", readAt: new Date(ms).toISOString() },
  ],
});
const empty: PositionResponse = { wallet: "WALLET", usdc: "100000000", positions: [], canAdvanceClock: true };
const held: PositionResponse = { wallet: "WALLET", usdc: "0", positions: [{ lender: "jupiter", shares: "93386371", usdc: "100000000" }], canAdvanceClock: true };

/** A server stand-in that records every call the page makes. */
function fakeApi(overrides: Partial<Api> = {}) {
  const calls: string[] = [];
  let position = empty;
  const api: Api = {
    rates: async () => (calls.push("rates"), ratesAt(T0)),
    position: async () => (calls.push("position"), position),
    deposit: async (amount, ratesId) => {
      calls.push(`deposit ${amount} rates#${ratesId}`);
      position = held;
      return { lender: "jupiter", amount: "100000000", signature: "SIG1" };
    },
    withdraw: async () => {
      calls.push("withdraw");
      position = { ...empty, usdc: "100012087" };
      return { withdrawals: [{ lender: "jupiter", signature: "SIG2", usdcReceived: "100012087" }] };
    },
    advanceDay: async () => void calls.push("advanceDay"),
    ...overrides,
  };
  return { api, calls };
}

const focused = () => document.activeElement as HTMLElement;

describe("S1: the page opens", () => {
  test("each rate is shown with its source and read time, and the higher one is marked", async () => {
    const { api } = fakeApi();
    render(<App api={api} now={() => T0 + 5_000} />);
    const kamino = within(await screen.findByTestId("lender-kamino"));
    const jupiter = within(screen.getByTestId("lender-jupiter"));
    await kamino.findByText("3.969%", { exact: false });
    expect(kamino.getByText("Kamino reserve D6q6 (slot 1)")).toBeTruthy();
    expect(kamino.getByText("2026-11-24T08:00:00.000Z").tagName).toBe("TIME");
    expect(kamino.getByText(/\(5s ago\)/)).toBeTruthy();
    expect(jupiter.getByText("4.400%", { exact: false })).toBeTruthy();
    expect(jupiter.getByText("https://jup.example/earn/tokens")).toBeTruthy();
    expect(jupiter.getByText("Higher")).toBeTruthy();
    // M2-007-S1: both labelled as the same kind of number.
    for (const card of [kamino, jupiter]) expect(card.getByTitle("a simple yearly rate").textContent).toBe("APR");
    expect(kamino.queryByText("Higher")).toBeNull();
    expect(screen.getByRole("button", { name: "Deposit with Jupiter Lend" })).toBeTruthy();
  });

  // The first build read the rates again on every tick of the page's clock and used up the lender's rate limit.
  test("the rates are read once, not again each second", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { api, calls } = fakeApi();
    render(<App api={api} />);
    await screen.findByText("4.400%", { exact: false });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(calls.filter((c) => c === "rates")).toHaveLength(1);
    expect(calls.filter((c) => c === "position")).toHaveLength(1);
  });

  test("a rate that could not be read is shown as not read, with the reason, and no lender is marked higher", async () => {
    const { api } = fakeApi({
      rates: async () => ({
        ...ratesAt(T0),
        higher: null,
        rates: [ratesAt(T0).rates[0]!, { lender: "jupiter", error: "HTTP 503" }],
        refusal: { code: "RATE_MISSING", message: "Jupiter Lend's rate could not be read: HTTP 503", lender: "jupiter" },
      }),
    });
    render(<App api={api} now={() => T0} />);
    expect(await screen.findByText("Not read: HTTP 503")).toBeTruthy();
    expect(screen.getByText("No choice can be made: Jupiter Lend's rate could not be read: HTTP 503")).toBeTruthy();
    expect(screen.queryByText("Higher")).toBeNull();
    expect(screen.getByRole("button", { name: "Deposit with the higher lender" })).toBeTruthy();
  });
});

describe("S3: the page refuses", () => {
  test("a refusal from the server is shown at the amount field and in the log, saying which input and that nothing was sent", async () => {
    const user = userEvent.setup();
    const { api } = fakeApi({
      deposit: async () => ({ refusal: { code: "RATE_STALE", message: "Kamino's rate is stale: read 75s ago, the limit is 60s", lender: "kamino" } }),
    });
    render(<App api={api} now={() => T0} />);
    await user.click(await screen.findByRole("button", { name: "Deposit with Jupiter Lend" }));
    const field = await screen.findByText("Kamino's rate is stale: read 75s ago, the limit is 60s. Nothing was sent.");
    expect(screen.getByRole("textbox", { name: "Amount in USDC" }).getAttribute("aria-describedby")).toContain(field.id);
    expect(within(screen.getByTestId("log")).getByText(/^Deposit refused: Kamino's rate is stale.+Nothing was sent\.$/)).toBeTruthy();
    expect(screen.getByTestId("wallet-usdc").textContent).toBe("100.000000 USDC");
  });

  test("reading the rates again clears the refusal, which was about the old ones", async () => {
    const user = userEvent.setup();
    const { api } = fakeApi({ deposit: async () => ({ refusal: { code: "RATE_STALE", message: "Kamino's rate is stale", lender: "kamino" } }) });
    render(<App api={api} now={() => T0} />);
    await user.click(await screen.findByRole("button", { name: "Deposit with Jupiter Lend" }));
    await screen.findByText("Kamino's rate is stale. Nothing was sent.");
    await user.click(screen.getByRole("button", { name: "Read the rates again" }));
    await waitFor(() => expect(screen.queryByText("Kamino's rate is stale. Nothing was sent.")).toBeNull());
    expect(within(screen.getByTestId("log")).getByText(/^Deposit refused/)).toBeTruthy();
  });

  test("rates left on the page past the limit are called out before any deposit is tried", async () => {
    const { api } = fakeApi();
    render(<App api={api} now={() => T0 + 61_000} />);
    expect(await screen.findByText(/These rates are more than 60 seconds old\. A deposit would be refused: read them again\./)).toBeTruthy();
  });

  test("an empty or zero amount cannot be sent", async () => {
    const user = userEvent.setup();
    const { api, calls } = fakeApi();
    render(<App api={api} now={() => T0} />);
    const amount = await screen.findByRole("textbox", { name: "Amount in USDC" });
    await user.clear(amount);
    const button = screen.getByRole("button", { name: /^Deposit with/ });
    expect(button.getAttribute("aria-disabled")).toBe("true");
    await user.click(button);
    expect(calls.some((c) => c.startsWith("deposit"))).toBe(false);
  });
});

describe("S2 and S4: compare, deposit and withdraw with the keyboard alone", () => {
  test("Tab reaches every control in order, arrow keys set the amount (a cent, or one USDC with Shift), Enter acts; no pointer is used", async () => {
    const user = userEvent.setup();
    const { api, calls } = fakeApi();
    render(<App api={api} now={() => T0} />);
    await screen.findByText("4.400%", { exact: false });
    await screen.findByText("Nothing is deposited with either lender.");

    await user.tab();
    expect(focused().textContent).toBe("Read the rates again");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(calls.filter((c) => c === "rates")).toHaveLength(2));

    await user.tab();
    expect(focused()).toBe(screen.getByRole("textbox", { name: "Amount in USDC" }));
    await user.keyboard("{Shift>}{ArrowDown}{ArrowDown}{ArrowDown}{/Shift}{ArrowUp}");
    expect((focused() as HTMLInputElement).value).toBe("97.01");

    await user.tab();
    expect(focused().textContent).toBe("Deposit with Jupiter Lend");
    await user.keyboard("{Enter}");
    expect(await screen.findByText(/held as 93386371 of the lender's own tokens/)).toBeTruthy();
    expect(calls).toContain("deposit 97.01 rates#1");

    await user.tab();
    expect(focused().textContent).toBe("Move the fork's clock forward one day");
    await user.keyboard(" ");
    await within(screen.getByTestId("log")).findByText("The fork's clock moved forward one day.");

    await user.tab();
    expect(focused().textContent).toBe("Withdraw everything");
    await user.keyboard("{Enter}");
    await within(screen.getByTestId("log")).findByText("Withdrew 100.012087 USDC from Jupiter Lend. Transaction SIG2");
    await waitFor(() => expect(screen.getByTestId("wallet-usdc").textContent).toBe("100.012087 USDC"));
    expect(calls.filter((c) => !["rates", "position"].includes(c))).toEqual(["deposit 97.01 rates#1", "advanceDay", "withdraw"]);
  });

  test("with nothing deposited, Withdraw can still be reached by Tab, says it is unavailable, and does nothing", async () => {
    const user = userEvent.setup();
    const { api, calls } = fakeApi();
    render(<App api={api} now={() => T0} />);
    await screen.findByText("Nothing is deposited with either lender.");
    const withdraw = screen.getByRole("button", { name: "Withdraw everything" });
    for (let i = 0; i < 5 && focused() !== withdraw; i++) await user.tab();
    expect(focused()).toBe(withdraw);
    expect(withdraw.getAttribute("aria-disabled")).toBe("true");
    await user.keyboard("{Enter}");
    expect(calls).not.toContain("withdraw");
  });

  test("a typed amount with cents is sent as plain text", async () => {
    const user = userEvent.setup();
    const { api, calls } = fakeApi();
    render(<App api={api} now={() => T0} />);
    const amount = await screen.findByRole("textbox", { name: "Amount in USDC" });
    await user.clear(amount);
    await user.type(amount, "12.5");
    await user.tab();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(calls).toContain("deposit 12.5 rates#1"));
  });
});
