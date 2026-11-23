import { readFileSync, writeFileSync } from 'node:fs';
import { setFlagsFromString } from 'node:v8';

setFlagsFromString('--no-turbofan --no-concurrent-recompilation --no-concurrent-sparkplug --no-maglev-build-code-on-background --no-maglev-deopt-data-on-background --no-maglev-destroy-on-background --no-concurrent-marking --no-concurrent-sweeping --no-parallel-scavenge --no-lazy --no-maglev-inlining --min-semi-space-size=16 --max-semi-space-size=16');

const { runCasesToBuffer } = await import('./solve.js');

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(`${INPUT_DIR}/cases.json`, 'utf8'));
writeFileSync(`${OUTPUT_DIR}/answers.json`, runCasesToBuffer(cases));
