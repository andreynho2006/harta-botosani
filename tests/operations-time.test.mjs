import assert from 'node:assert/strict';
import test from 'node:test';
import { localTime, isoTime, dateLabel } from '../web/js/operations-time.js';

test('Bucharest wall time uses winter and summer offsets explicitly', () => {
  assert.equal(localTime('2026-01-16T10:30:00.000Z'), '2026-01-16T12:30');
  assert.equal(localTime('2026-07-16T10:30:00.000Z'), '2026-07-16T13:30');
  assert.equal(isoTime('2026-01-16T12:30'), '2026-01-16T10:30:00.000Z');
  assert.equal(isoTime('2026-07-16T13:30'), '2026-07-16T10:30:00.000Z');
});

test('normal local times round trip including dates around midnight', () => {
  for (const value of ['2026-10-16T00:15', '2026-02-28T23:59', '2024-02-29T12:00', '2026-03-29T02:59', '2026-03-29T04:00']) {
    assert.equal(localTime(isoTime(value)), value);
  }
});

test('spring clock gap and invalid calendar dates are rejected', () => {
  for (const value of ['2026-03-29T03:00', '2026-03-29T03:30', '2026-03-29T03:59', '2026-02-29T12:00', '2026-04-31T12:00', '2026-01-01T24:00', '2026-01-01T12:60', '2026-1-1T12:00', 'invalid']) {
    assert.throws(() => isoTime(value), Error, value);
  }
  assert.throws(() => localTime('invalid'));
  assert.throws(() => dateLabel('2026-01-01T12:00'));
});

test('ambiguous autumn wall time consistently chooses the earlier instant', () => {
  assert.equal(isoTime('2026-10-25T03:30'), '2026-10-25T00:30:00.000Z');
  assert.equal(localTime('2026-10-25T00:30:00.000Z'), '2026-10-25T03:30');
  assert.equal(localTime('2026-10-25T01:30:00.000Z'), '2026-10-25T03:30');
});

test('empty values remain empty', () => {
  for (const fn of [localTime, isoTime, dateLabel]) {
    assert.equal(fn(''), '');
    assert.equal(fn(null), '');
    assert.equal(fn(undefined), '');
  }
});

test('display and parsing remain in Bucharest when the host timezone changes', () => {
  const previous = process.env.TZ;
  try {
    const iso = '2026-07-16T22:30:00.000Z';
    for (const zone of ['America/Los_Angeles', 'Asia/Tokyo', 'UTC']) {
      process.env.TZ = zone;
      assert.equal(localTime(iso), '2026-07-17T01:30');
      assert.equal(isoTime('2026-07-17T01:30'), iso);
      assert.match(dateLabel(iso), /17\.07\.2026/);
      assert.match(dateLabel(iso), /01:30/);
    }
  } finally {
    if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous;
  }
});
