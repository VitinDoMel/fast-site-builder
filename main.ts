import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';

setFlagsFromString('--invocation-count-for-turbofan=30000');
setFlagsFromString('--invocation-count-for-osr=8000');
setFlagsFromString('--max-lazy');

const { runCasesToBuffer } = await import('./solve.js');

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(INPUT_DIR, 'cases.json'), 'utf8'));
writeFileSync(join(OUTPUT_DIR, 'answers.json'), runCasesToBuffer(cases));
