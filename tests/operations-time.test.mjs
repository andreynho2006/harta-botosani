import assert from 'node:assert/strict';
import test from 'node:test';
import { localTime, isoTime, dateLabel, intervalLabel } from '../web/js/operations-time.js';

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

test('a same-day interval names its date once, by the county\'s day; one over two days names both', () => {
  assert.equal(intervalLabel('2026-10-17T03:00:00Z', '2026-10-17T17:00:00Z'), '17.10.2026, 06:00 – 20:00');
  assert.equal(intervalLabel('2026-10-17T03:00:00Z', '2026-10-17T17:00:00Z', true), '17.10, 06:00 – 20:00');
  assert.equal(intervalLabel('2026-10-25T09:00:00Z', '2026-10-26T06:00:00Z'), '25.10.2026, 11:00 – 26.10.2026, 08:00');
  assert.equal(intervalLabel('2026-10-25T09:00:00Z', '2026-10-26T06:00:00Z', true), '25.10, 11:00 – 26.10, 08:00');
  // The same UTC date spans two Bucharest days, and two UTC dates can fall on one.
  assert.equal(intervalLabel('2026-10-17T20:00:00Z', '2026-10-17T22:00:00Z'), '17.10.2026, 23:00 – 18.10.2026, 01:00');
  assert.equal(intervalLabel('2026-10-17T21:30:00Z', '2026-10-18T05:00:00Z'), '18.10.2026, 00:30 – 08:00');
  // 25.10.2026 has 25 hours: 01:00 summer time to 23:00 winter time is still one day.
  assert.equal(intervalLabel('2026-10-24T22:00:00Z', '2026-10-25T21:00:00Z'), '25.10.2026, 01:00 – 23:00');
  assert.throws(() => intervalLabel('2026-10-17T06:00', '2026-10-17T20:00:00Z'));
  assert.throws(() => intervalLabel('2026-10-17T06:00:00Z', ''));
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
      assert.equal(intervalLabel(iso, '2026-07-16T23:00:00.000Z'), '17.07.2026, 01:30 – 02:00');
    }
  } finally {
    if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous;
  }
});
