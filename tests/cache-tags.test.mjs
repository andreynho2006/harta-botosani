// GitHub Pages sends max-age=600 and the module graph is cached per URL: a module imported under two URLs is fetched
// and evaluated twice (two copies of its state), and tagging main.js alone does not refresh the modules it imports.
// So a module has exactly one import URL across web/js and index.html; changing a module changes that tag everywhere.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';

const web = new URL('../web/', import.meta.url);

// from '…', import '…', import('…'), new URL('…', import.meta.url) and <script src="…">, local .js files only
const REFERENCE = /(?:\bfrom\s*|\bimport\s*\(?\s*|\bnew URL\(\s*|<script\b[^>]*\bsrc=)(["'])([^"'\n]+\.js(?:\?[^"'\n]*)?)\1/g;

/** [{ file, url }] for every local JS file a source file refers to. */
function jsReferences(file, source) {
  const base = new URL(file, web);
  const found = [];
  for (const [, , specifier] of source.matchAll(REFERENCE)) {
    if (/^[a-z]+:/i.test(specifier)) continue;
    const url = new URL(specifier, base);
    found.push({ file, url: url.pathname.slice(web.pathname.length) + url.search });
  }
  return found;
}

/** Module path → the importers, grouped by the URL they use for it. */
function urlsByModule(files) {
  const modules = new Map();
  for (const file of files) {
    for (const { url } of jsReferences(file, readFileSync(new URL(file, web), 'utf8'))) {
      const path = url.split('?')[0];
      if (!modules.has(path)) modules.set(path, new Map());
      const urls = modules.get(path);
      urls.set(url, [...(urls.get(url) ?? []), file]);
    }
  }
  return modules;
}

/** The YYYYMMDD of the main.js tag in index.html, and the newest YYYYMMDD of any ?v=YYYYMMDD-name tag in the sources.
 *  Dates only: two tags from the same day with different names are the same release. */
function entryDates(sourceTexts) {
  const dates = sourceTexts.flatMap(([, source]) => [...source.matchAll(/\?v=(\d{8})-[a-z0-9-]+/g)].map(([, date]) => date));
  const page = sourceTexts.find(([file]) => file === 'index.html')?.[1] ?? '';
  return { entry: page.match(/js\/main\.js\?v=(\d{8})-[a-z0-9-]+/)?.[1] ?? null, newest: dates.sort().at(-1) ?? null };
}

const sources = [...readdirSync(new URL('js/', web)).filter(name => name.endsWith('.js')).map(name => `js/${name}`), 'index.html'];

test('the scan sees the module graph', () => {
  const modules = urlsByModule(sources);
  assert.ok(modules.size > 25, `only ${modules.size} modules found`);
  assert.ok(modules.has('js/main.js'), 'the page imports main.js');
  assert.ok([...modules.get('js/config.js').values()].flat().length >= 6, 'config.js has many importers');
  assert.ok(modules.has('js/intervention-route-worker.js'), 'the worker URL is a reference too');
});

test('every module is imported under one URL', () => {
  const split = [];
  for (const [path, urls] of urlsByModule(sources)) {
    if (urls.size > 1) split.push(`${path}: ${[...urls].map(([url, importers]) => `${url.split('?')[1] ?? 'untagged'} (${importers.join(', ')})`).join(' vs ')}`);
  }
  assert.deepEqual(split, []);
});

test('the page loads its entry module under a tag, so a new release is not served from the ten-minute cache', () => {
  const entry = urlsByModule(['index.html']).get('js/main.js');
  assert.deepEqual([...entry.keys()].map(url => /^js\/main\.js\?v=\d{8}-[a-z0-9-]+$/.test(url)), [true]);
});

test('the entry tag carries the newest release date, so a revert or a forgotten bump is not served from the ten-minute cache', () => {
  const { entry, newest } = entryDates(sources.map(file => [file, readFileSync(new URL(file, web), 'utf8')]));
  assert.equal(entry, newest, `index.html loads main.js under ${entry} while a module is tagged ${newest}`);
});

test('the entry date is compared with the newest tag, not with the whole tag', () => {
  const page = tag => ['index.html', `<script type="module" src="js/main.js?v=${tag}"></script>`];
  const module = tag => ['js/a.js', `import { a } from './b.js?v=${tag}';`];
  assert.deepEqual(entryDates([page('20261025-rivers'), module('20261026-hydro')]), { entry: '20261025', newest: '20261026' });
  assert.deepEqual(entryDates([page('20261026-hydro'), module('20261026-labels')]), { entry: '20261026', newest: '20261026' });
  assert.deepEqual(entryDates([page('20261026-hydro'), module('20261018-cards')]), { entry: '20261026', newest: '20261026' });
  assert.deepEqual(entryDates([['index.html', '<script type="module" src="js/main.js"></script>'], module('20261026-hydro')]), { entry: null, newest: '20261026' });
});

test('the scan tells a split module from a single one', () => {
  const split = jsReferences('js/a.js', `import { a } from './x.js?v=1';\nimport('./y.js');\nnew Worker(new URL('./w.js?v=2', import.meta.url));`);
  assert.deepEqual(split.map(({ url }) => url), ['js/x.js?v=1', 'js/y.js', 'js/w.js?v=2']);
  assert.deepEqual(jsReferences('index.html', '<script type="module" src="js/main.js?v=3"></script><script src="vendor/proj4.js"></script>')
    .map(({ url }) => url), ['js/main.js?v=3', 'vendor/proj4.js']);
  assert.deepEqual(jsReferences('js/a.js', `await import("https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js");`), []);
});
