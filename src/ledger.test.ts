import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import { buildLedger, ledgerFromFills } from './ledger.js';
import type { Fill } from './types.js';

const fill = (
  id: string,
  side: Fill['side'],
  quantity: number,
  price: number,
  time: number,
  extra: Partial<Pick<Fill, 'instrument' | 'fee'>> = {},
): Fill => ({ id, instrument: 'X', side, quantity, price, time, ...extra });

describe('one round trip', () => {
  it('buys then sells into one closed long trade', () => {
    const { trades } = ledgerFromFills([
      fill('a', 'buy', 2, 100, 1000),
      fill('b', 'sell', 2, 105, 2000),
    ]);
    expect(trades).toHaveLength(1);
    const [trade] = trades;
    expect(trade).toMatchObject({
      id: 'X:1000',
      side: 'long',
      status: 'closed',
      openedAt: 1000,
      closedAt: 2000,
      quantity: 2,
      exitedQuantity: 2,
      averageEntry: 100,
      averageExit: 105,
      realized: 10,
    });
  });

  it('sells then buys into one closed short trade with a loss', () => {
    const { trades } = ledgerFromFills([fill('a', 'sell', 1, 50, 1), fill('b', 'buy', 1, 52, 2)]);
    expect(trades[0]).toMatchObject({ side: 'short', status: 'closed', realized: -2 });
  });

  it('leaves an unmatched entry open with no average exit', () => {
    const { trades } = ledgerFromFills([fill('a', 'buy', 3, 10, 1)]);
    expect(trades[0]).toMatchObject({
      status: 'open',
      closedAt: null,
      averageExit: null,
      realized: 0,
    });
    expect(trades[0]?.legs[0]?.remaining).toBe(3);
  });
});

describe('scale-ins and partial exits', () => {
  it('allocates exits to legs first-in-first-out', () => {
    const { trades } = ledgerFromFills([
      fill('a', 'buy', 1, 100, 1),
      fill('b', 'buy', 1, 110, 2),
      fill('c', 'sell', 1, 120, 3), // closes leg a (+20), not leg b
      fill('d', 'sell', 1, 115, 4), // closes leg b (+5)
    ]);
    const [trade] = trades;
    expect(trade?.legs.map((leg) => leg.exits.map((exit) => exit.realized))).toEqual([[20], [5]]);
    expect(trade).toMatchObject({
      realized: 25,
      averageEntry: 105,
      averageExit: 117.5,
      closedAt: 4,
    });
  });

  it('splits one exit across two legs and keeps the trade open until flat', () => {
    const { trades } = ledgerFromFills([
      fill('a', 'buy', 1, 100, 1),
      fill('b', 'buy', 2, 100, 2),
      fill('c', 'sell', 2, 101, 3),
    ]);
    const [trade] = trades;
    expect(trade?.status).toBe('open');
    expect(trade?.legs.map((leg) => leg.remaining)).toEqual([0, 1]);
    expect(trade?.legs[1]?.exits[0]?.quantity).toBe(1);
    expect(trade?.exitedQuantity).toBe(2);
  });

  it('handles decimal quantities without drifting off flat', () => {
    const fills: Fill[] = [fill('a', 'buy', 0.3, 1, 1)];
    for (let i = 0; i < 3; i += 1) fills.push(fill(`s${String(i)}`, 'sell', 0.1, 1, 2 + i));
    const { trades } = ledgerFromFills(fills);
    expect(trades).toHaveLength(1);
    expect(trades[0]?.status).toBe('closed');
  });
});

describe('flips', () => {
  it('closes the trade and opens the opposite one from the same fill', () => {
    const { trades } = ledgerFromFills([
      fill('a', 'buy', 1, 100, 1),
      fill('b', 'sell', 3, 102, 2), // 1 closes the long, 2 open a short
      fill('c', 'buy', 2, 99, 3),
    ]);
    expect(trades.map((t) => [t.side, t.status, t.realized])).toEqual([
      ['long', 'closed', 2],
      ['short', 'closed', 6],
    ]);
    expect(trades[1]?.legs[0]).toMatchObject({ fillId: 'b', quantity: 2, price: 102 });
    expect(trades[1]?.id).toBe('X:2');
  });

  it('splits a flipping fill’s fee between the two trades by quantity', () => {
    const { trades } = ledgerFromFills([
      fill('a', 'buy', 1, 100, 1, { fee: 1 }),
      fill('b', 'sell', 4, 100, 2, { fee: 4 }),
    ]);
    expect(trades.map((t) => t.fees)).toEqual([2, 3]);
  });
});

describe('ids and ordering', () => {
  it('keeps instruments apart and orders trades by open time', () => {
    const { trades } = ledgerFromFills([
      fill('a', 'buy', 1, 1, 5, { instrument: 'B' }),
      fill('b', 'buy', 1, 1, 1, { instrument: 'A' }),
      fill('c', 'sell', 1, 2, 9, { instrument: 'A' }),
    ]);
    expect(trades.map((t) => t.id)).toEqual(['A:1', 'B:5']);
  });

  it('is independent of input order', () => {
    const fills = [
      fill('a', 'buy', 1, 100, 1),
      fill('b', 'buy', 1, 110, 2),
      fill('c', 'sell', 2, 120, 3),
      fill('d', 'sell', 1, 100, 4),
    ];
    const forward = ledgerFromFills(fills);
    const reversed = ledgerFromFills([...fills].reverse());
    expect(reversed).toEqual(forward);
  });

  it('suffixes a second trade opened in the same millisecond', () => {
    const { trades } = ledgerFromFills([
      fill('a', 'buy', 1, 1, 7),
      fill('b', 'sell', 1, 1, 7),
      fill('c', 'buy', 1, 1, 7),
    ]);
    expect(trades.map((t) => t.id)).toEqual(['X:7', 'X:7#2']);
  });

  it('applies a point-value multiplier per instrument', () => {
    const { trades } = ledgerFromFills([fill('a', 'buy', 1, 10, 1), fill('b', 'sell', 1, 11, 2)], {
      multipliers: { X: 20 },
    });
    expect(trades[0]?.realized).toBe(20);
  });
});

describe('parsing', () => {
  it('accepts ISO times and normalises them to milliseconds', () => {
    const { trades } = buildLedger([
      {
        id: 'a',
        instrument: 'X',
        side: 'buy',
        quantity: 1,
        price: 1,
        time: '2026-01-01T00:00:00Z',
      },
    ]);
    expect(trades[0]?.openedAt).toBe(Date.UTC(2026, 0, 1));
  });

  it('rejects bad shapes with a ZodError that names the field', () => {
    const bad = [{ id: 'a', instrument: 'X', side: 'hold', quantity: -1, price: 1, time: 0 }];
    expect(() => buildLedger(bad)).toThrow(ZodError);
    try {
      buildLedger(bad);
    } catch (error) {
      const paths = (error as ZodError).issues.map((issue) => issue.path.join('.'));
      expect(paths).toEqual(expect.arrayContaining(['0.side', '0.quantity']));
    }
  });

  it('rejects duplicate fill ids', () => {
    const dup = [
      { id: 'a', instrument: 'X', side: 'buy', quantity: 1, price: 1, time: 0 },
      { id: 'a', instrument: 'X', side: 'sell', quantity: 1, price: 1, time: 1 },
    ];
    expect(() => buildLedger(dup)).toThrow(/duplicate fill id/);
  });
});
