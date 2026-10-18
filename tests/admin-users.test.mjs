import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const authSource = await readFile(new URL('../web/js/auth.js', import.meta.url), 'utf8');
const adminSource = await readFile(new URL('../web/js/admin.js', import.meta.url), 'utf8');
const cryptoGlobals = { crypto: webcrypto, TextEncoder, TextDecoder, Uint8Array, btoa, atob };
const cryptoContext = vm.createContext(cryptoGlobals);
vm.runInContext(authSource.replace(/\bexport\s+/g, '') + '\nglobalThis.auth = { wrapFor, unlock };', cryptoContext);
const { wrapFor, unlock } = cryptoContext.auth;
const key = webcrypto.getRandomValues(new Uint8Array(32));
const iterations = 1000;
const admin = { u: 'administrator', name: 'Test administrator', role: 'admin', ...await wrapFor(key, 'synthetic-admin-password', iterations) };

function adminHarness(registry = { iterations, users: [admin] }, wrapping = wrapFor) {
  let fields, controls, html = '';
  const downloads = [], passwords = [], toasts = [], attributes = new Map();
  const el = {
    set innerHTML(value) {
      html = value;
      fields = {
        '#adm-user': { value: '', disabled: false },
        '#adm-name': { value: '', disabled: false },
        '#adm-role': { value: 'user', disabled: false },
      };
      controls = [...Object.values(fields), { disabled: false }, { disabled: false }];
    },
    get innerHTML() { return html; },
    querySelector: selector => fields[selector],
    querySelectorAll: () => controls,
    setAttribute: (name, value) => attributes.set(name, value),
    removeAttribute: name => attributes.delete(name),
  };
  const blobs = new Map();
  const context = vm.createContext({
    structuredClone, ITERATIONS: 310000, wrapFor: wrapping,
    generatePassword: () => { const value = `synthetic-user-password-${passwords.length + 1}`; passwords.push(value); return value; },
    Blob: class { constructor(parts) { this.json = parts.join(''); } },
    URL: { createObjectURL: blob => { const url = `blob:test-${blobs.size}`; blobs.set(url, blob); return url; }, revokeObjectURL() {} },
    document: { createElement: () => ({ click() { downloads.push({ name: this.download, json: blobs.get(this.href).json }); } }) },
    setTimeout: callback => callback(),
  });
  vm.runInContext(adminSource.replace(/^import .*;\n/gm, '').replace(/\bexport\s+/g, '') + '\nglobalThis.render = renderAdmin;', context);
  context.render(el, { session: { u: admin.u, key, users: registry }, state: { data: { hydrants: { features: [] } } }, toast: text => toasts.push(text), copy() {} });
  const click = dataset => el.onclick({ target: { closest: () => ({ dataset, disabled: false }) } });
  return {
    el, passwords, toasts, attributes,
    submit(username = 'operator') {
      fields['#adm-user'].value = username;
      fields['#adm-name'].value = 'Test operator';
      return el.onsubmit({ target: { id: 'adm-add' }, preventDefault() {} });
    },
    click,
    async export() {
      await click({ act: 'dl-users' });
      return downloads.length ? JSON.parse(downloads.at(-1).json) : null;
    },
    get downloadCount() { return downloads.length; },
    get shownPassword() { return html.match(/data-copy="([^"]+)"/)?.[1]; },
  };
}

async function login(registry, username, password) {
  let submit, readyResolve;
  const ready = new Promise(resolve => { readyResolve = resolve; });
  const fields = {
    '#lg-user': { value: username, focus() {} }, '#lg-pass': { value: password, select() {} },
    '#lg-remember': { checked: false }, 'button[type=submit]': { disabled: false },
  };
  const error = { hidden: true }, values = new Map();
  const storage = { getItem: name => values.get(name) ?? null, setItem: (name, value) => values.set(name, value), removeItem: name => values.delete(name) };
  const form = { querySelector: selector => fields[selector], addEventListener: (_, handler) => { submit = handler; readyResolve(); } };
  const screen = { hidden: true, querySelector: selector => selector === 'form' ? form : error };
  const context = vm.createContext({ ...cryptoGlobals, sessionStorage: storage, localStorage: storage,
    fetch: async () => ({ ok: true, json: async () => registry }),
    document: { getElementById: () => screen }, setTimeout: callback => callback() });
  vm.runInContext(authSource.replace(/\bexport\s+/g, '') + '\nglobalThis.login = ensureLogin;', context);
  const pending = context.login();
  await ready;
  await submit({ preventDefault() {} });
  assert.equal(error.hidden, true);
  return pending;
}

function deferredWrap() {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  return { release, wrap: async (...args) => { await gate; return wrapFor(...args); } };
}

test('new user creation, exported registry and full login work at production iterations', async () => {
  const productionAdmin = { ...admin, ...await wrapFor(key, 'synthetic-admin-password', 310000) };
  const registry = { iterations: 310000, users: [productionAdmin] };
  const h = adminHarness(registry);
  await h.submit();
  const exported = await h.export();
  assert.equal(exported.users.length, 2);
  assert.deepEqual(exported.users[0], productionAdmin);
  assert.equal(registry.users.length, 1);
  const session = await login(exported, 'operator', h.shownPassword);
  assert.equal(session.role, 'user');
  assert.deepEqual(session.key, key);
  assert.deepEqual(await unlock(exported.users[0], 'synthetic-admin-password', exported.iterations), key);
});

test('concurrent add, reset, delete and export cannot race an unfinished creation', async () => {
  const deferred = deferredWrap(), h = adminHarness(undefined, deferred.wrap);
  const first = h.submit();
  assert.equal(h.attributes.get('aria-busy'), 'true');
  assert.ok(h.el.querySelectorAll().every(control => control.disabled));
  await h.submit();
  await h.click({ reset: admin.u });
  await h.click({ del: admin.u, confirm: '1' });
  assert.equal(await h.export(), null);
  assert.equal(h.passwords.length, 1);
  deferred.release();
  await first;
  assert.equal(h.attributes.has('aria-busy'), false);
  assert.ok(h.el.querySelectorAll().every(control => !control.disabled));
  const exported = await h.export();
  assert.equal(exported.users.filter(user => user.u === 'operator').length, 1);
  assert.deepEqual(exported.users[0], admin);
  assert.equal(h.shownPassword, h.passwords[0]);
  assert.deepEqual(await unlock(exported.users[1], h.shownPassword, exported.iterations), key);
  assert.equal((await login(exported, 'operator', h.shownPassword)).role, 'user');
});

test('reset serializes changes and the displayed password unlocks the exported wrapper', async () => {
  const user = { u: 'operator', name: 'Test operator', role: 'user', ...await wrapFor(key, 'synthetic-old-password', iterations) };
  const deferred = deferredWrap(), h = adminHarness({ iterations, users: [admin, user] }, deferred.wrap);
  const pending = h.click({ reset: user.u });
  await h.click({ reset: user.u });
  await h.submit('another-user');
  assert.equal(h.passwords.length, 1);
  deferred.release();
  await pending;
  const exported = await h.export();
  assert.equal(exported.users.length, 2);
  assert.deepEqual(exported.users[0], admin);
  assert.equal(await unlock(exported.users[1], 'synthetic-old-password', iterations), null);
  assert.deepEqual(await unlock(exported.users[1], h.shownPassword, iterations), key);
});

test('failed crypto preserves users, unlocks controls and permits retry', async () => {
  let fail = true;
  const h = adminHarness(undefined, (...args) => {
    if (fail) { fail = false; throw new Error('Synthetic crypto failure'); }
    return wrapFor(...args);
  });
  await h.submit();
  assert.equal(h.toasts.length, 1);
  assert.equal(h.shownPassword, undefined);
  assert.ok(h.el.querySelectorAll().every(control => !control.disabled));
  assert.deepEqual((await h.export()).users, [admin]);
  await h.submit();
  const exported = await h.export();
  assert.equal(exported.users.length, 2);
  assert.deepEqual(await unlock(exported.users[1], h.shownPassword, iterations), key);
});

test('failed reset keeps the original wrapper and permits a later reset', async () => {
  let fail = true;
  const h = adminHarness(undefined, (...args) => {
    if (fail) { fail = false; return Promise.reject(new Error('Synthetic crypto failure')); }
    return wrapFor(...args);
  });
  await h.click({ reset: admin.u });
  assert.equal(h.toasts.length, 1);
  assert.deepEqual((await h.export()).users, [admin]);
  await h.click({ reset: admin.u });
  const exported = await h.export();
  assert.deepEqual(await unlock(exported.users[0], h.shownPassword, iterations), key);
});

test('prototype-shaped usernames have their own displayed and usable password', async () => {
  const h = adminHarness();
  await h.submit('__proto__');
  assert.equal(h.shownPassword, h.passwords[0]);
  const exported = await h.export();
  assert.deepEqual(await unlock(exported.users[1], h.shownPassword, iterations), key);
  assert.equal((await login(exported, '__proto__', h.shownPassword)).u, '__proto__');
});

test('fallback iteration count is exported with the new wrapper', async () => {
  for (const invalid of [undefined, 0, -1, '310000', 1.5]) {
    const h = adminHarness({ iterations: invalid, users: [admin] });
    await h.submit();
    const exported = await h.export();
    assert.equal(exported.iterations, 310000);
    assert.deepEqual(await unlock(exported.users[1], h.shownPassword, exported.iterations), key);
  }
});
