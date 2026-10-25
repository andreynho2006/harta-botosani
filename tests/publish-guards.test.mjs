import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const root = new URL('..', import.meta.url).pathname;
const workflow = readFileSync(new URL('../.github/workflows/site.yml', import.meta.url), 'utf8').split('\n');
const guardLines = workflow.filter(line => /^\s+rm -f site\//.test(line)).map(line => line.replace(/\s+#.*$/, '').trim());

test('site workflow strips plaintext hydrants and hydrography after assembling site/', () => {
  const lastCopy = workflow.findLastIndex(line => /^\s+cp -r .* site\/?$/.test(line));
  const firstGuard = workflow.findIndex(line => /^\s+rm -f site\//.test(line));
  assert.ok(lastCopy >= 0, 'the step that copies the app and the data into site/ is missing');
  assert.ok(firstGuard > lastCopy, 'the rm guards must run after the last copy into site/');
  assert.deepEqual(guardLines, ['rm -f site/data/hidranti.geojson', 'rm -f site/data/hidrografie*.geojson']);
});

test('the workflow guards drop clear GeoJSON and keep the encrypted files', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'site-guards-'));
  try {
    const data = path.join(dir, 'site', 'data');
    mkdirSync(data, { recursive: true });
    const names = ['hidranti.geojson', 'hidranti.enc', 'hidrografie.geojson', 'hidrografie-botosani.geojson', 'hidrografie.enc', 'admin.geojson'];
    for (const name of names) writeFileSync(path.join(data, name), 'x');
    for (const line of guardLines) execFileSync('sh', ['-c', line], { cwd: dir });
    assert.deepEqual(readdirSync(data).sort(), ['admin.geojson', 'hidranti.enc', 'hidrografie.enc']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('git ignores clear hydrography output but not the encrypted file', () => {
  const ignored = file => {
    try {
      execFileSync('git', ['check-ignore', '-q', file], { cwd: root, stdio: 'ignore' });
      return true;
    } catch (error) {
      if (error.status === 1) return false;
      throw error;
    }
  };
  for (const file of ['hidrografie.geojson', 'hidrografie-botosani.geojson', 'web/data/hidrografie.geojson', 'work/out/hidrografie-x.geojson']) {
    assert.equal(ignored(file), true, file);
  }
  assert.equal(ignored('web/data/hidrografie.enc'), false);
});
