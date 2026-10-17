import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../web/js/auth.js', import.meta.url), 'utf8');
const KEY = 'hb.session';

function storage(initial) {
  const values = new Map(initial === undefined ? [] : [[KEY, initial]]);
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
}

function harness(users, session, local) {
  const sessionStorage = storage(session);
  const localStorage = storage(local);
  const fields = {
    '#lg-user': { value: 'operator', focus() {} },
    '#lg-pass': { value: '', select() {} },
    '#lg-remember': { checked: false },
    'button[type=submit]': { disabled: false },
  };
  const error = { hidden: true };
  let submit;
  let onReady;
  const ready = new Promise((resolve) => { onReady = resolve; });
  const form = {
    querySelector: (selector) => fields[selector],
    addEventListener: (_, handler) => { submit = handler; onReady(); },
  };
  const login = {
    hidden: true,
    querySelector: (selector) => selector === 'form' ? form : error,
  };
  let reloads = 0;
  const context = vm.createContext({
    crypto: webcrypto, TextEncoder, TextDecoder, Uint8Array, btoa, atob,
    sessionStorage, localStorage,
    fetch: async () => ({ ok: true, json: async () => users }),
    document: { getElementById: () => login },
    location: { reload: () => { reloads++; } },
    setTimeout: (callback) => callback(),
  });
  vm.runInContext(source.replace(/\bexport\s+/g, '') +
    '\nglobalThis.auth = { ensureLogin, wrapFor, unlock, toB64, logout };', context);
  return {
    auth: context.auth, sessionStorage, localStorage, ready, login, fields, error,
    get reloads() { return reloads; },
    submit: () => submit({ preventDefault() {} }),
  };
}

const raw = webcrypto.getRandomValues(new Uint8Array(32));
const iterations = 1000;
const cryptoHarness = harness({ users: [] });
const wrapper = await cryptoHarness.auth.wrapFor(raw, 'old-password', iterations);
const entry = { u: 'operator', name: 'Operator', role: 'admin', ...wrapper };
const users = { iterations, users: [entry] };

async function loginAndSave(remember = false, initialSession, initialLocal) {
  const h = harness(users, initialSession, initialLocal);
  const pending = h.auth.ensureLogin();
  await h.ready;
  h.fields['#lg-pass'].value = 'old-password';
  h.fields['#lg-remember'].checked = remember;
  await h.submit();
  const result = await pending;
  assert.deepEqual(result.key, raw);
  const saved = JSON.parse((remember ? h.localStorage : h.sessionStorage).getItem(KEY));
  return { h, saved };
}

test('password reset rejects the old password and preserves the data key', async () => {
  assert.deepEqual(await cryptoHarness.auth.unlock(entry, 'old-password', iterations), raw);
  const reset = { ...entry, ...await cryptoHarness.auth.wrapFor(raw, 'new-password', iterations) };
  assert.equal(await cryptoHarness.auth.unlock(reset, 'old-password', iterations), null);
  assert.deepEqual(await cryptoHarness.auth.unlock(reset, 'new-password', iterations), raw);
});

test('login saves a fingerprint and replaces both session storage choices', async () => {
  for (const remember of [false, true]) {
    const { h, saved } = await loginAndSave(remember, 'malformed', 'malformed');
    assert.equal(typeof saved.f, 'string');
    assert.equal((remember ? h.sessionStorage : h.localStorage).getItem(KEY), null);
    const restored = harness(users, remember ? undefined : JSON.stringify(saved),
      remember ? JSON.stringify(saved) : undefined);
    assert.deepEqual((await restored.auth.ensureLogin()).key, raw);
    assert.equal(restored.login.hidden, true);
  }
});

test('reset wrappers, iteration changes, removed users and invalid sessions require login', async (t) => {
  const { saved } = await loginAndSave();
  const reset = { ...entry, ...await cryptoHarness.auth.wrapFor(raw, 'new-password', iterations) };
  const cases = [
    ['reset password', { iterations, users: [reset] }, saved],
    ['changed iterations', { ...users, iterations: iterations + 1 }, saved],
    ['removed user', { iterations, users: [] }, saved],
    ['legacy session', users, { u: entry.u, k: saved.k }],
    ['short key', users, { ...saved, k: cryptoHarness.auth.toB64(new Uint8Array(16)) }],
    ['invalid base64', users, { ...saved, k: '***' }],
    ['non-string key', users, { ...saved, k: {} }],
    ['null session', users, null],
    ['invalid JSON', users, '{'],
  ];
  for (const [name, registry, value] of cases) {
    await t.test(name, async () => {
      const encoded = typeof value === 'string' ? value : JSON.stringify(value);
      const h = harness(registry, encoded, encoded);
      h.auth.ensureLogin();
      await h.ready;
      assert.equal(h.login.hidden, false);
      assert.equal(h.sessionStorage.getItem(KEY), null);
      assert.equal(h.localStorage.getItem(KEY), null);
    });
  }
});

test('empty user lists show a login error without throwing', async () => {
  const h = harness({ iterations, users: [] });
  h.auth.ensureLogin();
  await h.ready;
  await h.submit();
  assert.equal(h.error.hidden, false);
  assert.equal(h.fields['button[type=submit]'].disabled, false);
});

test('a regular test user can retry a failed login and restore the correct role', async () => {
  const password = 'test-fixture-password';
  const regular = { u: 'test', name: 'Test user', role: 'user',
    ...await cryptoHarness.auth.wrapFor(raw, password, iterations) };
  const registry = { iterations, users: [entry, regular] };
  const h = harness(registry);
  const pending = h.auth.ensureLogin();
  await h.ready;
  h.fields['#lg-user'].value = ' TEST ';
  h.fields['#lg-pass'].value = 'wrong-password';
  await h.submit();
  assert.equal(h.error.hidden, false);
  assert.equal(h.login.hidden, false);
  assert.equal(h.sessionStorage.getItem(KEY), null);
  h.fields['#lg-pass'].value = password;
  await h.submit();
  const result = await pending;
  assert.equal(result.u, 'test');
  assert.equal(result.role, 'user');
  assert.deepEqual(result.key, raw);
  assert.equal(h.login.hidden, true);
  const restored = harness(registry, h.sessionStorage.getItem(KEY));
  const session = await restored.auth.ensureLogin();
  assert.equal(session.u, 'test');
  assert.equal(session.role, 'user');
  assert.deepEqual(session.key, raw);
});

test('logout clears both stores and reloads the page', () => {
  const h = harness(users, 'session', 'remembered');
  h.auth.logout();
  assert.equal(h.sessionStorage.getItem(KEY), null);
  assert.equal(h.localStorage.getItem(KEY), null);
  assert.equal(h.reloads, 1);
});
