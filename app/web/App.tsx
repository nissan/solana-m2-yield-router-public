import { Button } from "@ui-sdk/react/button";
import { Field, FieldDescription, FieldError, FieldLabel } from "@ui-sdk/react/field";
import { NumberInput, NumberInputControl, NumberInputDecrement, NumberInputGroup, NumberInputIncrement } from "@ui-sdk/react/number-input";
import { useCallback, useEffect, useState } from "react";
import { LENDER_NAMES, LENDERS, formatUsdc } from "../src/rates.ts";
import { type Api, type PositionResponse, type RatesResponse, type Refusal, isRefused } from "./api.ts";

type Entry = { id: number; kind: "done" | "refused" | "failed"; text: string };

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const usdc = (units: string) => formatUsdc(BigInt(units));
/** A number from the amount field as the text the server parses: no exponent, at most six decimals. */
const amountText = (value: number) => value.toFixed(6).replace(/\.?0+$/, "");

// One function for the page's lifetime: a new one each render would make every effect below run again.
const wallClock = () => Date.now();

export function App({ api, now = wallClock }: { api: Api; now?: () => number }) {
  const [rates, setRates] = useState<RatesResponse | null>(null);
  const [ratesError, setRatesError] = useState<string | null>(null);
  const [position, setPosition] = useState<PositionResponse | null>(null);
  const [amount, setAmount] = useState<number | null>(100);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [log, setLog] = useState<Entry[]>([]);
  const [clock, setClock] = useState(now);

  const note = useCallback((kind: Entry["kind"], text: string) => setLog((entries) => [{ id: entries.length + 1, kind, text }, ...entries]), []);

  const readRates = useCallback(async () => {
    try {
      setRates(await api.rates());
      setRatesError(null);
      // A refusal was about the rates it was made with; these are new ones.
      setRefusal(null);
    } catch (error) {
      setRates(null);
      setRatesError(message(error));
    }
    setClock(now());
  }, [api, now]);

  const readPosition = useCallback(async () => {
    try {
      setPosition(await api.position());
    } catch (error) {
      note("failed", `Could not read the wallet: ${message(error)}`);
    }
  }, [api, note]);

  useEffect(() => {
    void readRates();
    void readPosition();
  }, [readRates, readPosition]);

  // The ages on the page tick, so a rate can be seen going stale.
  useEffect(() => {
    const timer = setInterval(() => setClock(now()), 1000);
    return () => clearInterval(timer);
  }, [now]);

  const oldestMs = rates ? Math.max(0, ...rates.rates.map((r) => ("readAt" in r ? clock - Date.parse(r.readAt) : 0))) : 0;
  const stale = rates !== null && oldestMs > rates.freshnessLimitMs;

  async function deposit() {
    setRefusal(null);
    if (!rates || amount === null) return;
    try {
      const result = await api.deposit(amountText(amount), rates.id);
      if (isRefused(result)) {
        setRefusal(result.refusal);
        note("refused", `Deposit refused: ${result.refusal.message}. Nothing was sent.`);
      } else {
        note("done", `Deposited ${usdc(result.amount)} USDC with ${LENDER_NAMES[result.lender]}. Transaction ${result.signature}`);
      }
    } catch (error) {
      note("failed", `Deposit failed: ${message(error)}`);
    }
    await readPosition();
  }

  async function withdraw() {
    try {
      const result = await api.withdraw();
      if (isRefused(result)) note("refused", `Withdrawal refused: ${result.refusal.message}. Nothing was sent.`);
      else if (result.withdrawals.length === 0) note("done", "Nothing to withdraw.");
      else for (const w of result.withdrawals) note("done", `Withdrew ${usdc(w.usdcReceived)} USDC from ${LENDER_NAMES[w.lender]}. Transaction ${w.signature}`);
    } catch (error) {
      note("failed", `Withdrawal failed: ${message(error)}`);
    }
    await readPosition();
  }

  async function advanceDay() {
    try {
      await api.advanceDay();
      note("done", "The fork's clock moved forward one day.");
    } catch (error) {
      note("failed", `Could not move the fork's clock: ${message(error)}`);
    }
    await readPosition();
  }

  const higher = rates?.higher ?? null;
  const hasPosition = (position?.positions.length ?? 0) > 0;

  return (
    <main>
      <header>
        <h1>Stablecoin yield router</h1>
        <p className="notice">A fork of mainnet on this machine, with a test wallet. No real funds move.</p>
      </header>

      <section aria-labelledby="compare-heading">
        <h2 id="compare-heading">1. Compare</h2>
        <p>Two lenders pay interest on USDC. Their rates move all day, so the router reads both before it acts. Both are simple yearly rates (APR), including any rewards, so they can be compared.</p>
        {ratesError && <p role="alert">The rates could not be read: {ratesError}</p>}
        <ul className="lenders">
          {LENDERS.map((lender) => {
            const reading = rates?.rates.find((r) => r.lender === lender);
            const isHigher = higher === lender;
            return (
              <li key={lender} className="lender" data-higher={isHigher || undefined} data-testid={`lender-${lender}`}>
                <h3>
                  {LENDER_NAMES[lender]} {isHigher && <span className="badge">Higher</span>}
                </h3>
                {!reading ? (
                  <p>Reading…</p>
                ) : "error" in reading ? (
                  <p className="problem">Not read: {reading.error}</p>
                ) : (
                  <>
                    <p className="rate">
                      {reading.ratePercent.toFixed(3)}% <abbr title="a simple yearly rate">APR</abbr>
                    </p>
                    <dl>
                      <dt>Read</dt>
                      <dd>
                        <time dateTime={reading.readAt}>{reading.readAt}</time> ({Math.max(0, Math.round((clock - Date.parse(reading.readAt)) / 1000))}s ago)
                      </dd>
                      <dt>Source</dt>
                      <dd className="source">{reading.source}</dd>
                    </dl>
                  </>
                )}
              </li>
            );
          })}
        </ul>
        {rates?.refusal && <p className="problem">No choice can be made: {rates.refusal.message}</p>}
        {stale && (
          <p className="problem" role="status">
            These rates are more than {Math.round(rates.freshnessLimitMs / 1000)} seconds old. A deposit would be refused: read them again.
          </p>
        )}
        <Button onClick={readRates} pendingAnnouncement="Reading rates">
          Read the rates again
        </Button>
      </section>

      <section aria-labelledby="wallet-heading">
        <h2 id="wallet-heading">2. Your position</h2>
        {!position ? (
          <p>Reading…</p>
        ) : (
          <>
            <p>
              Test wallet <code>{position.wallet}</code> holds <strong data-testid="wallet-usdc">{usdc(position.usdc)} USDC</strong>.
            </p>
            {hasPosition ? (
              <ul data-testid="positions">
                {position.positions.map((p) => (
                  <li key={p.lender}>
                    {LENDER_NAMES[p.lender]}: about <strong>{usdc(p.usdc)} USDC</strong>, held as {p.shares} of the lender's own tokens in the wallet.
                  </li>
                ))}
              </ul>
            ) : (
              <p data-testid="positions">Nothing is deposited with either lender.</p>
            )}
          </>
        )}
      </section>

      <section aria-labelledby="deposit-heading">
        <h2 id="deposit-heading">3. Deposit</h2>
        <p>The deposit goes to whichever lender reads higher. If either rate is missing or stale, it is refused.</p>
        <Field invalid={refusal ? true : undefined}>
          <FieldLabel>Amount in USDC</FieldLabel>
          <NumberInput value={amount} onValueChange={setAmount} min={0} step={0.01} largeStep={1} format={{ maximumFractionDigits: 2, useGrouping: false }}>
            <NumberInputGroup>
              <NumberInputDecrement aria-label="One cent less" />
              <NumberInputControl />
              <NumberInputIncrement aria-label="One cent more" />
            </NumberInputGroup>
          </NumberInput>
          <FieldDescription>To the cent. Arrow keys change it by a cent; hold Shift for one USDC.</FieldDescription>
          {refusal && <FieldError match>{refusal.message}. Nothing was sent.</FieldError>}
        </Field>
        <Button onClick={deposit} disabled={!rates || amount === null || amount <= 0} focusableWhenDisabled pendingAnnouncement="Depositing">
          {higher ? `Deposit with ${LENDER_NAMES[higher]}` : "Deposit with the higher lender"}
        </Button>
      </section>

      <section aria-labelledby="withdraw-heading">
        <h2 id="withdraw-heading">4. Withdraw</h2>
        <p>Everything comes back to the wallet. Lenders round in their own favour, so taking it out at once returns a few millionths of a dollar less; after a day the interest is more than that.</p>
        {position?.canAdvanceClock && (
          <Button onClick={advanceDay} pendingAnnouncement="Moving the clock">
            Move the fork's clock forward one day
          </Button>
        )}
        <Button onClick={withdraw} disabled={!hasPosition} focusableWhenDisabled pendingAnnouncement="Withdrawing">
          Withdraw everything
        </Button>
      </section>

      <section aria-labelledby="log-heading">
        <h2 id="log-heading">What happened</h2>
        <ol className="log" reversed aria-live="polite" data-testid="log">
          {log.length === 0 && <li>Nothing yet.</li>}
          {log.map((entry) => (
            <li key={entry.id} data-kind={entry.kind}>
              {entry.text}
            </li>
          ))}
        </ol>
      </section>
    </main>
  );
}
