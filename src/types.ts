import { z } from 'zod';

/**
 * One execution report from a broker: a quantity bought or sold at a price,
 * at a point in time. Fees are optional and attributed to the trade the fill
 * ends up in. `time` accepts epoch milliseconds or an ISO-8601 string and is
 * normalised to milliseconds.
 */
export const FillSchema = z
  .object({
    id: z.string().min(1),
    instrument: z.string().min(1),
    side: z.enum(['buy', 'sell']),
    quantity: z.number().positive().finite(),
    price: z.number().nonnegative().finite(),
    time: z
      .union([z.number().int().nonnegative(), z.string().datetime({ offset: true })])
      .transform((value) => (typeof value === 'number' ? value : Date.parse(value))),
    fee: z.number().nonnegative().finite().optional(),
  })
  .strict();

export const FillsSchema = z.array(FillSchema).superRefine((fills, ctx) => {
  const seen = new Set<string>();
  fills.forEach((fill, index) => {
    if (seen.has(fill.id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [index, 'id'],
        message: `duplicate fill id "${fill.id}"`,
      });
    }
    seen.add(fill.id);
  });
});

export type Fill = z.output<typeof FillSchema>;
export type Side = Fill['side'];
export type Direction = 'long' | 'short';

/** Part of a leg closed by one fill. */
export interface Exit {
  fillId: string;
  quantity: number;
  price: number;
  time: number;
  fee: number;
  /** Profit on this slice, in price points × quantity × multiplier. Fees excluded. */
  realized: number;
}

/** One entry fill (or the part of a fill that entered) and the exits taken against it. */
export interface Leg {
  fillId: string;
  quantity: number;
  price: number;
  time: number;
  fee: number;
  /** Quantity not yet exited. Zero on every leg of a closed trade. */
  remaining: number;
  exits: Exit[];
}

/** One flat → flat excursion on an instrument. */
export interface Trade {
  /** Deterministic: `${instrument}:${openedAt}`, suffixed `#n` only on a same-millisecond collision. */
  id: string;
  instrument: string;
  side: Direction;
  status: 'open' | 'closed';
  openedAt: number;
  closedAt: number | null;
  legs: Leg[];
  /** Total quantity entered across all legs. */
  quantity: number;
  /** Total quantity exited so far. Equals `quantity` when closed. */
  exitedQuantity: number;
  /** Entry price weighted by leg quantity. */
  averageEntry: number;
  /** Exit price weighted by exit quantity, or null before the first exit. */
  averageExit: number | null;
  /** Sum of exit profits, fees excluded. */
  realized: number;
  /** Entry and exit fees attributed to this trade. */
  fees: number;
}

export interface LedgerOptions {
  /** Point value per instrument (e.g. 20 for a contract worth $20 a point). Defaults to 1. */
  multipliers?: Readonly<Record<string, number>>;
}

export interface Ledger {
  /** Every trade, ordered by open time then instrument. */
  trades: Trade[];
}
