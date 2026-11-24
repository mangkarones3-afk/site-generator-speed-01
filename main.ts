// Driver for the sitegen entry: the harness runs `node /bot/main.ts`.
// Primary route: the native CLI inside engine.node — its
// runAll(inputDir, outputDir, slugCore) reads cases.json, renders every
// case and writes answers.json itself, all on the native side. Any
// failure loading the addon or running runAll falls back to the per-case
// loop below, which answers each case with run() from solve.js (which in
// turn prefers its native renderCase and otherwise runs the pure-JS
// implementation). Outside the sandbox, MAKEFUN_INPUT_DIR and
// MAKEFUN_OUTPUT_DIR name the two folders.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { setFlagsFromString } from 'node:v8';

// Match the house driver's runtime tuning: incremental marking off, set
// before solve.js loads so all of its work runs under it.
setFlagsFromString('--no-incremental-marking');

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// The native side calls back here for the Unicode part of slug building:
// NFKD decomposition with combining marks stripped, exactly as solve.js
// does it for its own slug path.
const slugCore = (s: string): string => s.normalize('NFKD').replace(/\p{M}/gu, '');

let usedNativeCli = false;
try {
  const requireNative = createRequire(import.meta.url);
  const engine = requireNative('./engine.node') as {
    runAll?: (inputDir: string, outputDir: string, slugFn: (s: string) => string) => number;
  };
  if (engine && typeof engine.runAll === 'function') {
    engine.runAll(inputDir, outputDir, slugCore);
    usedNativeCli = true;
  }
} catch {
  usedNativeCli = false;
}

if (!usedNativeCli) {
  const solveModule = (await import(new URL('./solve.js', import.meta.url).href)) as {
    run: (input: unknown) => unknown;
  };
  const caseList = JSON.parse(readFileSync(join(inputDir, 'cases.json'), 'utf8')) as { id: string; input: unknown }[];
  const answers: unknown[] = [];
  for (const entry of caseList) answers.push(solveModule.run(entry.input));
  writeFileSync(join(outputDir, 'answers.json'), JSON.stringify(answers));
}
