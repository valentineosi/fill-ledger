import type { Ledger, Trade } from './types.js';

const money = (n: number): string => (n < 0 ? `-${(-n).toFixed(2)}` : n.toFixed(2));
const qty = (n: number): string => String(Number(n.toFixed(8)));
const when = (ms: number): string => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);

interface Column {
  header: string;
  align: 'left' | 'right';
  cell: (trade: Trade) => string;
}

const COLUMNS: readonly Column[] = [
  { header: 'opened', align: 'left', cell: (t) => when(t.openedAt) },
  { header: 'instrument', align: 'left', cell: (t) => t.instrument },
  { header: 'side', align: 'left', cell: (t) => t.side },
  { header: 'legs', align: 'right', cell: (t) => String(t.legs.length) },
  { header: 'qty', align: 'right', cell: (t) => qty(t.quantity) },
  { header: 'avg in', align: 'right', cell: (t) => money(t.averageEntry) },
  {
    header: 'avg out',
    align: 'right',
    cell: (t) => (t.averageExit === null ? '-' : money(t.averageExit)),
  },
  { header: 'realized', align: 'right', cell: (t) => money(t.realized) },
  { header: 'fees', align: 'right', cell: (t) => money(t.fees) },
  { header: 'status', align: 'left', cell: (t) => t.status },
];

/** A fixed-width table, one row per trade, plus a totals line. */
export const renderTable = (ledger: Ledger): string => {
  const rows = ledger.trades.map((trade) => COLUMNS.map((column) => column.cell(trade)));
  const widths = COLUMNS.map((column, i) =>
    Math.max(column.header.length, ...rows.map((row) => row[i]?.length ?? 0)),
  );
  const pad = (text: string, i: number): string => {
    const column = COLUMNS[i];
    const width = widths[i] ?? text.length;
    return column?.align === 'right' ? text.padStart(width) : text.padEnd(width);
  };
  const line = (cells: readonly string[]): string => cells.map(pad).join('  ').trimEnd();

  const header = line(COLUMNS.map((column) => column.header));
  const rule = widths.map((w) => '-'.repeat(w)).join('  ');
  const body = rows.map(line);
  return [header, rule, ...body, '', summary(ledger)].join('\n');
};

/** One line: counts and totals over the whole ledger. */
export const summary = (ledger: Ledger): string => {
  const closed = ledger.trades.filter((t) => t.status === 'closed');
  const open = ledger.trades.length - closed.length;
  const realized = closed.reduce((sum, t) => sum + t.realized, 0);
  const fees = ledger.trades.reduce((sum, t) => sum + t.fees, 0);
  const wins = closed.filter((t) => t.realized > 0).length;
  return (
    `${String(closed.length)} closed (${String(wins)} won), ${String(open)} open · ` +
    `realized ${money(realized)} · fees ${money(fees)} · net ${money(realized - fees)}`
  );
};
