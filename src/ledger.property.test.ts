import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { ledgerFromFills } from './ledger.js';
import type { Fill, Trade } from './types.js';

// Random fill streams: two instruments, small decimal quantities, prices in a
// narrow band, times that collide often enough to exercise the tie-break.
const sideArb: fc.Arbitrary<Fill['side']> = fc.constantFrom('buy', 'sell');

const fillArb = fc
  .record({
    instrument: fc.constantFrom('P', 'Q'),
    side: sideArb,
    quantity: fc.integer({ min: 1, max: 40 }).map((n) => n / 10),
    price: fc.integer({ min: 9000, max: 11000 }).map((n) => n / 100),
    time: fc.integer({ min: 0, max: 50 }),
    fee: fc.option(
      fc.integer({ min: 0, max: 300 }).map((n) => n / 100),
      { nil: null },
    ),
  })
  // `fee` is optional on Fill, so a missing fee is an absent key, not undefined.
  .map(({ fee, ...rest }) => (fee === null ? rest : { ...rest, fee }));

const fillsArb = fc
  .array(fillArb, { minLength: 0, maxLength: 40 })
  .map((fills): Fill[] => fills.map((f, i) => ({ ...f, id: `f${String(i)}` })));

const near = (a: number, b: number): boolean => Math.abs(a - b) < 1e-6;
const sum = (xs: readonly number[]): number => xs.reduce((s, x) => s + x, 0);

const signedCash = (trade: Trade): number => {
  // Σ exit value − Σ entry value, signed for direction, must equal realized
  // whatever FIFO did — the pairing only moves profit between legs.
  const entered = sum(trade.legs.map((leg) => leg.quantity * leg.price));
  const exited = sum(trade.legs.flatMap((leg) => leg.exits.map((e) => e.quantity * e.price)));
  return trade.side === 'long' ? exited - entered : entered - exited;
};

describe('ledger invariants', () => {
  it('conserves quantity: every unit filled is an entry or an exit', () => {
    fc.assert(
      fc.property(fillsArb, (fills) => {
        const { trades } = ledgerFromFills(fills);
        const filled = sum(fills.map((f) => f.quantity));
        const booked = sum(trades.map((t) => t.quantity + t.exitedQuantity));
        expect(near(filled, booked)).toBe(true);
      }),
    );
  });

  it('realized profit of a closed trade equals its signed cash flow', () => {
    fc.assert(
      fc.property(fillsArb, (fills) => {
        for (const trade of ledgerFromFills(fills).trades) {
          if (trade.status !== 'closed') continue;
          expect(near(trade.realized, signedCash(trade))).toBe(true);
          expect(near(trade.quantity, trade.exitedQuantity)).toBe(true);
          expect(trade.legs.every((leg) => near(leg.remaining, 0))).toBe(true);
        }
      }),
    );
  });

  it('keeps at most one open trade per instrument, always the last one', () => {
    fc.assert(
      fc.property(fillsArb, (fills) => {
        const { trades } = ledgerFromFills(fills);
        for (const instrument of new Set(trades.map((t) => t.instrument))) {
          const own = trades.filter((t) => t.instrument === instrument);
          const open = own.filter((t) => t.status === 'open');
          expect(open.length).toBeLessThanOrEqual(1);
          if (open.length === 1) expect(own.at(-1)).toBe(open[0]);
          own.slice(1).forEach((trade, i) => {
            expect(trade.openedAt).toBeGreaterThanOrEqual(own[i]?.closedAt ?? Infinity);
          });
        }
      }),
    );
  });

  it('attributes every fee exactly once', () => {
    fc.assert(
      fc.property(fillsArb, (fills) => {
        const { trades } = ledgerFromFills(fills);
        expect(near(sum(fills.map((f) => f.fee ?? 0)), sum(trades.map((t) => t.fees)))).toBe(true);
      }),
    );
  });

  it('gives the same ledger for any input order and unique ids', () => {
    fc.assert(
      fc.property(fillsArb, fc.integer(), (fills, seed) => {
        const shuffled = [...fills].sort((a, b) => hash(a.id, seed) - hash(b.id, seed));
        expect(ledgerFromFills(shuffled)).toEqual(ledgerFromFills(fills));
        const ids = ledgerFromFills(fills).trades.map((t) => t.id);
        expect(new Set(ids).size).toBe(ids.length);
      }),
    );
  });
});

const hash = (s: string, seed: number): number => {
  let h = seed | 0;
  for (const ch of s) h = (Math.imul(h ^ ch.charCodeAt(0), 16777619) + 1) | 0;
  return h;
};
