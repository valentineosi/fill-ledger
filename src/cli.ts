#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { ZodError } from 'zod';
import { renderTable } from './format.js';
import { buildLedger } from './ledger.js';
import type { LedgerOptions } from './types.js';

const USAGE = `usage: fill-ledger <fills.json> [--multiplier INSTRUMENT=POINT_VALUE]...

  fills.json   an array of { id, instrument, side, quantity, price, time, fee? }
  --multiplier point value for an instrument (repeatable); defaults to 1
`;

interface Args {
  file: string;
  options: LedgerOptions;
}

export const parseArgs = (argv: readonly string[]): Args => {
  let file: string | undefined;
  const multipliers: Record<string, number> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--multiplier') {
      const spec = argv[i + 1];
      const [instrument, value] = spec?.split('=') ?? [];
      const multiplier = Number(value);
      if (!instrument || !Number.isFinite(multiplier) || multiplier <= 0) {
        throw new Error(`--multiplier expects INSTRUMENT=POINT_VALUE, got "${spec ?? ''}"`);
      }
      multipliers[instrument] = multiplier;
      i += 1;
    } else if (arg?.startsWith('--')) {
      throw new Error(`unknown option ${arg}`);
    } else if (arg !== undefined) {
      if (file !== undefined) throw new Error('only one fills file is accepted');
      file = arg;
    }
  }
  if (file === undefined) throw new Error('a fills file is required');
  return { file, options: { multipliers } };
};

const main = (): number => {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`);
    return 2;
  }

  let input: unknown;
  try {
    input = JSON.parse(readFileSync(args.file, 'utf8'));
  } catch (error) {
    process.stderr.write(
      `could not read ${args.file}: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }

  try {
    process.stdout.write(`${renderTable(buildLedger(input, args.options))}\n`);
    return 0;
  } catch (error) {
    if (error instanceof ZodError) {
      process.stderr.write('invalid fills:\n');
      for (const issue of error.issues) {
        process.stderr.write(`  at ${issue.path.join('.') || '(root)'}: ${issue.message}\n`);
      }
      return 1;
    }
    throw error;
  }
};

if (process.argv[1]?.endsWith('cli.ts') || process.argv[1]?.endsWith('cli.js')) {
  process.exitCode = main();
}
