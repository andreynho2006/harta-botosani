// The Chrome the browser tests drive: CHROME_BIN, else the usual macOS and Linux installs.
// Without one they are skipped with the reason, unless REQUIRE_CHROME (set in CI) makes that a failure.
import { existsSync } from 'node:fs';

const candidates = [process.env.CHROME_BIN, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'].filter(Boolean);
export const chrome = candidates.find(path => existsSync(path)) ?? candidates[0];
export const skipWithoutChrome = existsSync(chrome) || process.env.REQUIRE_CHROME ? false : 'Chrome not found: set CHROME_BIN to run the browser tests';
