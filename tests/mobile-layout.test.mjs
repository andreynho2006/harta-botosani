import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { chrome, skipWithoutChrome } from './chrome.mjs';

const sizes = [[320, 568], [390, 844], [844, 390], [900, 480], [1366, 768]];

function layoutChecks() {
  try {
    document.querySelector('#login')?.remove();
    document.querySelector('#loading')?.remove();
    document.querySelector('.side').dataset.sheet = 'half';
    document.querySelector('.topbar').innerHTML = '<input aria-label="Search fixture" value="Search">';
    const compact = innerWidth <= 760 || innerHeight <= 520;
    const toggle = document.querySelector('#mobile-map-toggle');
    const visible = el => el && getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0;
    const reachable = el => {
      if (!visible(el)) return false;
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return r.top >= 0 && r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight && (hit === el || el.contains(hit));
    };
    const result = { viewport: innerWidth + 'x' + innerHeight };
    result.initialControlVisibility = Boolean(visible(toggle)) === compact;
    result.initialSidebarVisible = Boolean(visible(document.querySelector('.side')));
    result.initialExpandedAria = toggle.getAttribute('aria-expanded') === 'true';
    result.ariaControlsExist = toggle.getAttribute('aria-controls').split(/\s+/).every(id => document.getElementById(id));
    if (compact) {
      document.body.classList.add('mobile-map-only');
      result.panelsCollapse = ['.side', '.topbar', '.toolbar'].every(selector => !visible(document.querySelector(selector)));
      result.arrowReachableWhenCollapsed = reachable(toggle);
      const rect = toggle.getBoundingClientRect();
      result.arrow44px = rect.width >= 44 && rect.height >= 44;
      result.mapCenterReceivesInput = !document.elementFromPoint(innerWidth / 2, innerHeight / 2)?.closest('.side,.topbar,.toolbar,.mobile-map-toggle');
      result.noHorizontalOverflow = document.documentElement.scrollWidth <= innerWidth;
      document.body.classList.remove('mobile-map-only');
      result.sidebarRestores = visible(document.querySelector('.side')) && document.querySelector('.side').dataset.sheet === 'half';
      result.arrowReachableWhenExpanded = reachable(toggle);
      document.body.classList.add('presenting');
      result.mainArrowHiddenInCjsu = !visible(toggle);
    }
    parent.postMessage(result, '*');
  } catch (error) { parent.postMessage({ viewport: innerWidth + 'x' + innerHeight, error: error.stack }, '*'); }
}

test('main-map CSS can collapse all normal panels and preserve the mobile restore arrow', { skip: skipWithoutChrome }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'main-mobile-layout-'));
  try {
    const web = new URL('../web/', import.meta.url);
    // Use production markup and styles; auth, network data and map mounting are outside this CSS regression.
    const child = readFileSync(new URL('index.html', web), 'utf8')
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/href="((?:css|vendor)\/[^\"]+)"/g, (_, path) => `href="${new URL(path, web).href}"`)
      .replace('</body>', `<script>(${layoutChecks.toString()})()</script></body>`);
    const harness = `<body><pre id="results"></pre><script>
      const results = [];
      onmessage = event => { results.push(event.data); document.querySelector('#results').textContent = JSON.stringify(results); };
      for (const [width, height] of ${JSON.stringify(sizes)}) {
        const frame = document.createElement('iframe'); frame.width = width; frame.height = height;
        frame.srcdoc = ${JSON.stringify(child).replaceAll('<', '\\u003c')}; document.body.append(frame);
      }
    </script>`;
    const path = join(dir, 'test.html'); writeFileSync(path, harness);
    const run = spawnSync(chrome, ['--headless', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--allow-file-access-from-files', '--user-data-dir=' + join(dir, 'profile'), '--virtual-time-budget=5000', '--dump-dom', pathToFileURL(path).href], { encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024 });
    assert.equal(run.status, 0, run.error?.message || run.stderr || String(run.signal));
    const match = run.stdout.match(/<pre id="results">([\s\S]*?)<\/pre>/);
    assert.ok(match?.[1], 'Browser did not complete the layout checks: ' + run.stderr.slice(-2000));
    const results = JSON.parse(match[1].replaceAll('&amp;', '&').replaceAll('&lt;', '<').replaceAll('&gt;', '>'));
    assert.equal(results.length, sizes.length, 'Incomplete browser results: ' + JSON.stringify(results));
    const failures = results.flatMap(result => result.error ? [result.viewport + ': ' + result.error] : Object.entries(result).filter(([check, passed]) => check !== 'viewport' && !passed).map(([check]) => result.viewport + ': ' + check));
    assert.deepEqual(failures, [], failures.join('\n'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
