// Exercise registry. Every board, form field, history label and ranking reads from it.
//
//   id      storage key: a fixed athletes column for group 'main', otherwise a key in
//           the athletes.lifts JSONB map (adding one of those needs NO schema change).
//   unit    'kg'   one decimal, higher ranks higher
//           'reps' whole number, higher ranks higher
//           'time' whole seconds, shown and entered as m:ss; longer ranks higher
//                  unless lowerIsBetter (e.g. a run), which ranks faster first
//   group   tab: 'main' (fixed columns: adding one needs a migration), 'other' or 'cardio'
//
// A new extra exercise with unit 'kg' must also be listed in the SQL function
// public.lift_allows_decimals(); tests/database.test.mjs checks the two agree.
window.EXERCISES = [
  { id: 'squat',    emoji: '🦵', label: 'Squat',        unit: 'kg',   group: 'main' },
  { id: 'bench',    emoji: '🏋️', label: 'Bench Press',  unit: 'kg',   group: 'main' },
  { id: 'deadlift', emoji: '💀', label: 'Deadlift',     unit: 'kg',   group: 'main' },
  { id: 'deadhang', emoji: '🐒', label: 'Dead Hang',    unit: 'time', group: 'other' },
  { id: 'pullups',  emoji: '🧗', label: 'Chill-ups',    unit: 'reps', group: 'other' },
  { id: 'pushups',  emoji: '💪', label: 'Push-ups',     unit: 'reps', group: 'other' },
  { id: 'run1k',    emoji: '🏃', label: 'Fastest 1 km', unit: 'time', group: 'cardio', lowerIsBetter: true },
];

// Shared domain rules for boards, forms and history. No DOM or database access.
window.Lifts = (() => {
  const MAX = 99999;
  const all = window.EXERCISES;
  const main = all.filter((e) => e.group === 'main').map((e) => e.id);
  const extra = all.filter((e) => e.group !== 'main');
  const TOTAL = { id: 'total', emoji: '🏆', label: 'Total', unit: 'kg', group: 'total' };
  // Form sections and tabs, in display order.
  const groups = [
    { id: 'main', emoji: '🏋️', label: 'Main lifts' },
    { id: 'other', emoji: '🤸', label: 'Other lifts' },
    { id: 'cardio', emoji: '🏃', label: 'Cardio' },
  ];
  const get = (id) => id === 'total' ? TOTAL : all.find((e) => e.id === id);
  const inGroup = (group) => all.filter((e) => e.group === group);
  const unit = (id) => get(id)?.unit || 'kg';

  // Invalid input stays invalid; never turn a typo such as "6:99" into a 6-second PR.
  // Phones' decimal keypads have no colon, so "1.30" and "1,30" also mean 1:30.
  const formatTime = (seconds) => {
    const n = Number(seconds);
    const s = Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0;
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };
  const parseTime = (input) => {
    const str = String(input ?? '').trim();
    if (!str) return 0;
    const match = str.match(/^(\d+)[:.,]([0-5]\d)$/);
    const seconds = match ? Number(match[1]) * 60 + Number(match[2])
      : /^\d+$/.test(str) ? Number(str) : NaN;
    return Number.isSafeInteger(seconds) ? seconds : NaN;
  };

  const number = (raw) => Number.isFinite(Number(raw)) ? Math.max(0, Number(raw)) : 0;
  const value = (athlete, id) => id === 'total'
    // Sum integer tenths so equal decimal totals also share an exact rank.
    ? main.reduce((sum, lift) => sum + Math.round(number(athlete[lift]) * 10), 0) / 10
    : number(main.includes(id) ? athlete[id] : athlete.lifts?.[id]);
  const format = (id, raw) => unit(id) === 'time' ? formatTime(raw)
    : unit(id) === 'reps' ? String(Math.round(number(raw))) : number(raw).toFixed(1);
  const formatUnit = (id, raw) => format(id, raw) + (unit(id) === 'time' ? '' : ` ${unit(id)}`);
  // Signed change in the exercise's unit: "+12.5 kg", "−0:08", "+3 reps".
  const formatDelta = (id, delta) => {
    const sign = delta > 0 ? '+' : delta < 0 ? '−' : '';
    const size = Math.abs(delta);
    if (unit(id) === 'time') return `${sign}${formatTime(size)}`;
    if (unit(id) === 'reps') return `${sign}${Math.round(size)} reps`;
    return `${sign}${size.toFixed(1)} kg`;
  };
  // A new score beats the old one: zero means "no entry", so any first score counts.
  const improves = (id, from, to) => {
    const a = number(from), b = number(to);
    if (b <= 0) return false;
    if (a <= 0) return true;
    return get(id)?.lowerIsBetter ? b < a : b > a;
  };

  // Competition ranks (1, 1, 3); zero/missing scores are not on the board.
  const ranked = (athletes, id) => {
    const direction = get(id)?.lowerIsBetter ? 1 : -1;
    const rows = athletes.map((athlete) => ({ athlete, value: value(athlete, id) }))
      .filter((row) => row.value > 0)
      .sort((a, b) => direction * (a.value - b.value) || a.athlete.name.localeCompare(b.athlete.name));
    let rank = 0;
    return rows.map((row, i) => {
      if (i === 0 || row.value !== rows[i - 1].value) rank = i + 1;
      return { ...row, rank };
    });
  };

  // Form input → stored value, or NaN when invalid for the exercise's unit.
  const parse = (id, input) => {
    const raw = String(input ?? '').trim();
    const n = unit(id) === 'time' ? parseTime(raw)
      : raw === '' ? 0 : /^\d+(?:\.\d+)?$/.test(raw) ? Number(raw) : NaN;
    if (!Number.isFinite(n) || n < 0 || n > MAX) return NaN;
    if (unit(id) !== 'kg' && !Number.isInteger(n)) return NaN;
    if (unit(id) === 'kg' && Math.abs(n * 10 - Math.round(n * 10)) > 0.000001) return NaN;
    return n;
  };
  // Stored value → the text a form field shows; blank means "no entry".
  const inputValue = (id, raw) => number(raw) <= 0 ? '' : unit(id) === 'time' ? formatTime(raw) : String(number(raw));
  const unitHint = (id) => ({ kg: 'kg', reps: 'reps', time: 'm:ss' })[unit(id)];

  return { MAX, all, main, extra, groups, get, inGroup, unit, value, format, formatUnit, formatDelta,
    improves, ranked, parse, inputValue, unitHint, formatTime, parseTime };
})();
