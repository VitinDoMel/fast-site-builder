import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';

setFlagsFromString('--no-turbofan');
setFlagsFromString('--no-concurrent-recompilation');
setFlagsFromString('--no-concurrent-marking');
setFlagsFromString('--no-concurrent-sweeping');
setFlagsFromString('--no-parallel-scavenge');
setFlagsFromString('--no-lazy');

const { runCasesToBuffer } = await import('./solve.js');

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(INPUT_DIR, 'cases.json'), 'utf8'));
writeFileSync(join(OUTPUT_DIR, 'answers.json'), runCasesToBuffer(cases));
