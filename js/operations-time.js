const TIME_ZONE = 'Europe/Bucharest';
const wallFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});
const labelFormatter = new Intl.DateTimeFormat('ro-RO', {
  timeZone: TIME_ZONE, dateStyle: 'short', timeStyle: 'short',
});
const shortLabelFormatter = new Intl.DateTimeFormat('ro-RO', {
  timeZone: TIME_ZONE, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
});
const clockFormatter = new Intl.DateTimeFormat('ro-RO', { timeZone: TIME_ZONE, timeStyle: 'short' });

function dateFromISO(value) {
  if (typeof value !== 'string' || !/(Z|[+-]\d{2}:\d{2})$/i.test(value)) throw new Error('A timestamp with an explicit UTC offset is required.');
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('Invalid timestamp.');
  return date;
}

function wallParts(date) {
  return Object.fromEntries(wallFormatter.formatToParts(date)
    .filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
}

function wallString(date) {
  const p = wallParts(date);
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

function wallMilliseconds(date) {
  const p = wallParts(date);
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
}

/** Format a UTC timestamp for a datetime-local input in the county's timezone. */
export function localTime(iso) {
  if (iso === '' || iso == null) return '';
  return wallString(dateFromISO(iso));
}

/** Parse Bucharest wall time. Repeated autumn times choose the earlier instant. */
export function isoTime(value) {
  if (value === '' || value == null) return '';
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) throw new Error('Invalid local date and time.');
  const [year, month, day, hour, minute] = value.match(/\d+/g).map(Number);
  if (year < 1900 || year > 9999 || month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) throw new Error('Invalid local date and time.');
  const target = Date.UTC(year, month - 1, day, hour, minute);
  if (new Date(target).toISOString().slice(0, 16) !== value) throw new Error('Invalid calendar date.');

  // Refine the UTC estimate using the timezone offset at that instant.
  // Collect nearby offsets as well so a repeated autumn hour can be resolved
  // consistently and a nonexistent spring hour fails the exact round trip.
  const offsets = new Set();
  let candidate = target;
  for (let step = 0; step < 4; step++) {
    const offset = wallMilliseconds(new Date(candidate)) - candidate;
    offsets.add(offset);
    const next = target - offset;
    if (next === candidate) break;
    candidate = next;
  }
  for (const hours of [-36, 36]) {
    const instant = target + hours * 3600000;
    offsets.add(wallMilliseconds(new Date(instant)) - instant);
  }
  const matches = [...offsets].map(offset => target - offset)
    .filter(instant => wallString(new Date(instant)) === value).sort((a, b) => a - b);
  if (!matches.length) throw new Error('This local time does not exist in Europe/Bucharest.');
  return new Date(matches[0]).toISOString();
}

export function dateLabel(iso) {
  if (iso === '' || iso == null) return '';
  return labelFormatter.format(dateFromISO(iso));
}

/** "17.10.2026, 06:00 – 20:00": an end on the start's day in the county shows only its time. `short` drops the year. */
export function intervalLabel(fromIso, toIso, short = false) {
  const from = dateFromISO(fromIso), to = dateFromISO(toIso);
  const format = short ? shortLabelFormatter : labelFormatter;
  const sameDay = wallString(from).slice(0, 10) === wallString(to).slice(0, 10);
  return `${format.format(from)} – ${(sameDay ? clockFormatter : format).format(to)}`;
}
