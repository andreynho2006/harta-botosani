// main.js drives the DOM and the map at load time, so its functions are tested by running a slice of its source
// in a vm with stand-ins for what the slice uses (the way commune.test.mjs does for showInfo).
import { readFileSync } from 'node:fs';

export const main = readFileSync(new URL('../../web/js/main.js', import.meta.url), 'utf8');

/** The source from `from` up to (not including) `to`; fails loudly when either marker moved. */
export function mainSlice(from, to) {
  const start = main.indexOf(from);
  if (start < 0) throw new Error(`main.js no longer contains ${from}`);
  const end = main.indexOf(to, start + from.length);
  if (end < 0) throw new Error(`main.js no longer contains ${to} after ${from}`);
  return main.slice(start, end);
}
