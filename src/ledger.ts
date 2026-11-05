import { FillsSchema } from './types.js';
import type { Direction, Fill, Ledger, LedgerOptions, Trade } from './types.js';

// ── Rounding ─────────────────────────────────────────────────────────
// Quantities are decimals (0.1 lots, 0.0035 coins), so "flat" cannot be a
// strict `=== 0` test after a few subtractions. Everything is rounded to
// eight places and compared against an epsilon below that.

const PLACES = 1e8;
const EPS = 1e-9;
const round = (n: number): number => Math.round(n * PLACES) / PLACES;
const isZero = (n: number): boolean => Math.abs(n) < EPS;

/** Direction a fill pushes the position in. */
const directionOf = (fill: Fill): Direction => (fill.side === 'buy' ? 'long' : 'short');

/** Price points gained on `quantity`, signed for the trade's direction. */
const profit = (
  side: Direction,
  entry: number,
  exit: number,
  quantity: number,
  multiplier: number,
): number => (side === 'long' ? exit - entry : entry - exit) * quantity * multiplier;

/** Chronological order with the id as a tie-break so same-millisecond fills are deterministic. */
export const sortFills = (fills: readonly Fill[]): Fill[] =>
  [...fills].sort((a, b) => a.time - b.time || a.id.localeCompare(b.id));

/**
 * Parses unknown input as fills (throws a ZodError on bad shape) and builds
 * the ledger. Use `ledgerFromFills` when the input is already typed.
 */
export const buildLedger = (input: unknown, options: LedgerOptions = {}): Ledger =>
  ledgerFromFills(FillsSchema.parse(input), options);

/**
 * Walks each instrument's fills in time order tracking the net position.
 * A trade opens on the first fill away from flat and closes when the
 * position returns to flat; every fill in the trade's direction is a leg,
 * and fills against it are allocated to open legs first-in-first-out.
 * A fill larger than the open position closes the trade and opens the next
 * one in the opposite direction with the remainder (a flip).
 */
export const ledgerFromFills = (fills: readonly Fill[], options: LedgerOptions = {}): Ledger => {
  const byInstrument = new Map<string, Fill[]>();
  for (const fill of sortFills(fills)) {
    const group = byInstrument.get(fill.instrument);
    if (group) group.push(fill);
    else byInstrument.set(fill.instrument, [fill]);
  }

  const trades: Trade[] = [];
  for (const [instrument, group] of byInstrument) {
    trades.push(...walkInstrument(instrument, group, options.multipliers?.[instrument] ?? 1));
  }
  trades.sort((a, b) => a.openedAt - b.openedAt || a.instrument.localeCompare(b.instrument));
  return { trades };
};

const walkInstrument = (
  instrument: string,
  fills: readonly Fill[],
  multiplier: number,
): Trade[] => {
  const out: Trade[] = [];
  const idsIssued = new Map<string, number>();
  let open: Trade | null = null;

  const newTrade = (side: Direction, openedAt: number): Trade => {
    const base = `${instrument}:${String(openedAt)}`;
    const n = (idsIssued.get(base) ?? 0) + 1;
    idsIssued.set(base, n);
    return {
      id: n === 1 ? base : `${base}#${String(n)}`,
      instrument,
      side,
      status: 'open',
      openedAt,
      closedAt: null,
      legs: [],
      quantity: 0,
      exitedQuantity: 0,
      averageEntry: 0,
      averageExit: null,
      realized: 0,
      fees: 0,
    };
  };

  for (const fill of fills) {
    const direction = directionOf(fill);
    let quantity = fill.quantity;
    let fee = fill.fee ?? 0;
    const feePerUnit = fee / quantity;

    // A flip re-enters this loop with the leftover quantity, which then
    // opens the next trade — one fill can feed two trades.
    while (!isZero(quantity)) {
      open ??= newTrade(direction, fill.time);

      if (open.side === direction) {
        open.legs.push({
          fillId: fill.id,
          quantity,
          price: fill.price,
          time: fill.time,
          fee,
          remaining: quantity,
          exits: [],
        });
        quantity = 0;
        fee = 0;
        continue;
      }

      for (const leg of open.legs) {
        if (isZero(quantity)) break;
        if (isZero(leg.remaining)) continue;
        const take = Math.min(leg.remaining, quantity);
        const takeFee = round(feePerUnit * take);
        leg.exits.push({
          fillId: fill.id,
          quantity: round(take),
          price: fill.price,
          time: fill.time,
          fee: takeFee,
          realized: round(profit(open.side, leg.price, fill.price, take, multiplier)),
        });
        leg.remaining = round(leg.remaining - take);
        quantity = round(quantity - take);
        fee = round(fee - takeFee);
      }

      if (open.legs.every((leg) => isZero(leg.remaining))) {
        out.push(finalize(open, fill.time));
        open = null;
      }
    }
  }

  if (open) out.push(finalize(open, null));
  return out;
};

/** Fills in the derived totals once a trade's legs are settled. */
const finalize = (trade: Trade, closedAt: number | null): Trade => {
  let entered = 0;
  let enteredValue = 0;
  let exited = 0;
  let exitedValue = 0;
  let realized = 0;
  let fees = 0;
  for (const leg of trade.legs) {
    entered += leg.quantity;
    enteredValue += leg.quantity * leg.price;
    fees += leg.fee;
    for (const exit of leg.exits) {
      exited += exit.quantity;
      exitedValue += exit.quantity * exit.price;
      realized += exit.realized;
      fees += exit.fee;
    }
  }
  trade.quantity = round(entered);
  trade.exitedQuantity = round(exited);
  trade.averageEntry = round(enteredValue / entered);
  trade.averageExit = isZero(exited) ? null : round(exitedValue / exited);
  trade.realized = round(realized);
  trade.fees = round(fees);
  trade.closedAt = closedAt;
  trade.status = closedAt === null ? 'open' : 'closed';
  return trade;
};
