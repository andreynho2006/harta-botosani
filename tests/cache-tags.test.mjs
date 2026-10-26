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

test('the scan tells a split module from a single one', () => {
  const split = jsReferences('js/a.js', `import { a } from './x.js?v=1';\nimport('./y.js');\nnew Worker(new URL('./w.js?v=2', import.meta.url));`);
  assert.deepEqual(split.map(({ url }) => url), ['js/x.js?v=1', 'js/y.js', 'js/w.js?v=2']);
  assert.deepEqual(jsReferences('index.html', '<script type="module" src="js/main.js?v=3"></script><script src="vendor/proj4.js"></script>')
    .map(({ url }) => url), ['js/main.js?v=3', 'vendor/proj4.js']);
  assert.deepEqual(jsReferences('js/a.js', `await import("https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js");`), []);
});
