import { describe, expect, it } from 'vitest';
import { parseArgs } from './cli.js';
import { renderTable, summary } from './format.js';
import { ledgerFromFills } from './ledger.js';

const ledger = ledgerFromFills([
  { id: 'a', instrument: 'ALPHA', side: 'buy', quantity: 2, price: 100, time: 0, fee: 1 },
  { id: 'b', instrument: 'ALPHA', side: 'sell', quantity: 2, price: 103.5, time: 60_000, fee: 1 },
  { id: 'c', instrument: 'BETA', side: 'sell', quantity: 0.5, price: 2500, time: 120_000 },
]);

describe('renderTable', () => {
  it('prints one aligned row per trade and a totals line', () => {
    const text = renderTable(ledger);
    const lines = text.split('\n');
    expect(lines[0]).toMatch(/^opened\s+instrument\s+side\s+legs\s+qty/);
    expect(lines[2]).toMatch(
      /^1970-01-01 00:00:00 {2}ALPHA\s+long\s+1\s+2\s+100\.00\s+103\.50\s+7\.00\s+2\.00\s+closed$/,
    );
    expect(lines[3]).toMatch(/BETA\s+short\s+1\s+0\.5\s+2500\.00\s+-\s+0\.00\s+0\.00\s+open$/);
    expect(lines.at(-1)).toBe(summary(ledger));
  });

  it('summarises counts, realized, fees and net', () => {
    expect(summary(ledger)).toBe('1 closed (1 won), 1 open · realized 7.00 · fees 2.00 · net 5.00');
  });
});

describe('parseArgs', () => {
  it('reads the file and repeated multipliers', () => {
    expect(
      parseArgs(['fills.json', '--multiplier', 'ALPHA=20', '--multiplier', 'BETA=0.1']),
    ).toEqual({
      file: 'fills.json',
      options: { multipliers: { ALPHA: 20, BETA: 0.1 } },
    });
  });

  it('rejects a missing file, a bad multiplier and unknown options', () => {
    expect(() => parseArgs([])).toThrow(/fills file is required/);
    expect(() => parseArgs(['f.json', '--multiplier', 'ALPHA'])).toThrow(/INSTRUMENT=POINT_VALUE/);
    expect(() => parseArgs(['f.json', '--verbose'])).toThrow(/unknown option/);
  });
});
