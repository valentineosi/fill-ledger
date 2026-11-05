# fill-ledger

Turns a raw stream of broker fills into round-trip trades: each flat → flat excursion on an instrument
becomes one trade, scale-ins become legs, and exits are matched to legs first-in-first-out.

```text
$ npm run cli -- examples/fills.json --multiplier ALPHA=20

opened               instrument  side   legs  qty   avg in  avg out  realized  fees  status
-------------------  ----------  -----  ----  ---  -------  -------  --------  ----  ------
2026-03-02 14:31:00  ALPHA       long      2    3   100.50   103.33    170.00  3.60  closed
2026-03-02 15:00:00  BETA        short     1  0.5  2500.00  2490.00      5.00  0.00  closed
2026-03-02 15:45:00  BETA        long      1  0.5  2490.00  2510.00     10.00  0.00  closed
2026-03-03 14:35:00  ALPHA       long      1    1   102.00        -      0.00  0.60  open

3 closed (3 won), 1 open · realized 185.00 · fees 4.20 · net 180.80
```

## Run it

```sh
npm install
npm test
npm run cli -- examples/fills.json --multiplier ALPHA=20
```

## How it works

**The problem.** Brokers report _fills_, not trades. A position that is opened, added to twice, trimmed and
closed arrives as five unrelated execution reports, and a broker's position id often survives going flat
and reopening, so it cannot be used to tell one trade from the next.

**Net quantity is the source of truth.** Fills are grouped by instrument and walked in time order (fill id
breaks ties, so the result never depends on input order). A trade opens on the first fill that moves the
position away from flat and closes on the fill that brings it back. Fills in the trade's direction become
**legs**; fills against it are **exits**, allocated to the oldest leg with quantity remaining (FIFO), so
each exit slice knows exactly which entry it closed and what it earned.

**Flips.** A sell of 3 against a long of 1 closes the long with 1 and opens a short with the remaining 2.
One fill can therefore feed two trades; its fee is split between them in proportion to quantity.

**Deterministic ids.** A trade's id is `instrument:openedAt`, so re-running the ledger over the same fills,
or over a superset, gives existing trades the same ids — safe to upsert. A second trade opened in the same
millisecond gets a `#2` suffix.

**Decimals.** Lot sizes like 0.1 and 0.0035 don't survive repeated subtraction in floating point, so
quantities are rounded to 8 places and "flat" is an epsilon test, not `=== 0`.

**Input is untrusted.** `buildLedger` parses with [Zod](https://zod.dev): unknown keys, negative
quantities, bad sides, unparseable timestamps and duplicate fill ids are rejected with the offending path.
`ledgerFromFills` skips parsing for already-typed input.

**Tests.** Example tests pin the behaviours above. Property tests ([fast-check](https://fast-check.dev))
throw random fill streams at the ledger and check invariants that must hold for _any_ input:

- every unit filled is booked as an entry or an exit (quantity is conserved);
- a closed trade's realized profit equals its signed cash flow, whatever FIFO paired with what;
- each fee is attributed exactly once, flips included;
- an instrument has at most one open trade, always its latest, and trades never overlap;
- the ledger is identical for any input order, and trade ids are unique.

Realized figures are in price points × quantity × the instrument's multiplier, before fees; the summary line
reports fees and net separately.

## Licence

[MIT](LICENSE)
