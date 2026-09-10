// "Other lifts" registry — extra exercises beyond the three fixed main columns
// (squat/bench/deadlift). These live in the athletes.lifts jsonb map, so adding
// one needs NO schema change.
//
// To add an exercise: append one entry here. The board sections, the "My PRs" form,
// and the admin form all read from this list — no other code changes.
//   id     jsonb key stored in athletes.lifts.
//   unit   formatting + input + ranking:
//            'kg'   numeric, one decimal — HIGHER ranks higher.
//            'reps' whole number        — HIGHER ranks higher.
//            'time' whole seconds, stored/shown as m:ss and ENTERED as m:ss
//                   (parseLiftTime) — LONGER ranks higher, unless lowerIsBetter
//                   (e.g. a run) flips it so FASTER ranks higher.
//   group  which tab the board appears under: 'other' (default, "Other Lifts" tab)
//          or 'cardio' (the "Cardio" tab). Both share the athletes.lifts store.
window.OTHER_LIFTS = [
  { id: 'deadhang', emoji: '🐒', label: 'Dead Hang', unit: 'time' },
  { id: 'pullups',  emoji: '🧗', label: 'Chill-ups', unit: 'reps' },
  { id: 'pushups',  emoji: '💪', label: 'Push-ups', unit: 'reps' },
  { id: 'run1k',    emoji: '🏃', label: 'Fastest 1 km', unit: 'time', lowerIsBetter: true, group: 'cardio' },
];

window.getOtherLift = (id) => window.OTHER_LIFTS.find((l) => l.id === id);

// Invalid input stays invalid; never turn a typo such as "6:99" into a 6-second PR.
window.formatLiftTime = (seconds) => {
  const n = Number(seconds);
  const s = Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
window.parseLiftTime = (input) => {
  const str = String(input ?? '').trim();
  if (!str) return 0;
  const match = str.match(/^(\d+):([0-5]\d)$/);
  const seconds = match ? Number(match[1]) * 60 + Number(match[2])
    : /^\d+$/.test(str) ? Number(str) : NaN;
  return Number.isSafeInteger(seconds) ? seconds : NaN;
};

// Shared domain rules for tables, podiums, forms and history. No DOM or database.
window.Lifts = (() => {
  const main = ['squat', 'bench', 'deadlift'];
  const meta = {
    squat: { emoji: '🦵', label: 'Squat' },
    bench: { emoji: '🏋️', label: 'Bench Press' },
    deadlift: { emoji: '💀', label: 'Deadlift' },
    total: { emoji: '🏆', label: 'Total' },
  };
  const number = (raw) => Number.isFinite(Number(raw)) ? Math.max(0, Number(raw)) : 0;
  const value = (athlete, id) => id === 'total'
    // Sum integer tenths so equal decimal totals also share an exact rank.
    ? main.reduce((sum, lift) => sum + Math.round(number(athlete[lift]) * 10), 0) / 10
    : number(main.includes(id) ? athlete[id] : athlete.lifts?.[id]);
  const unit = (id) => window.getOtherLift(id)?.unit || 'kg';
  const format = (id, raw) => unit(id) === 'time' ? window.formatLiftTime(raw)
    : unit(id) === 'reps' ? String(Math.round(number(raw))) : number(raw).toFixed(1);
  const formatUnit = (id, raw) => format(id, raw) + (unit(id) === 'time' ? '' : ` ${unit(id)}`);
  const ranked = (athletes, id) => {
    const direction = window.getOtherLift(id)?.lowerIsBetter ? 1 : -1;
    const rows = athletes.map((athlete) => ({ athlete, value: value(athlete, id) }))
      .filter((row) => row.value > 0)
      .sort((a, b) => direction * (a.value - b.value) || a.athlete.name.localeCompare(b.athlete.name));
    let rank = 0;
    return rows.map((row, i) => {
      if (i === 0 || row.value !== rows[i - 1].value) rank = i + 1;
      return { ...row, rank };
    });
  };
  const parse = (id, input) => {
    const raw = String(input ?? '').trim();
    const n = unit(id) === 'time' ? window.parseLiftTime(raw)
      : raw === '' ? 0 : /^\d+(?:\.\d+)?$/.test(raw) ? Number(raw) : NaN;
    if (!Number.isFinite(n) || n < 0 || n > 99999) return NaN;
    if (unit(id) !== 'kg' && !Number.isInteger(n)) return NaN;
    if (unit(id) === 'kg' && Math.abs(n * 10 - Math.round(n * 10)) > 0.000001) return NaN;
    return n;
  };
  return { main, meta, value, unit, format, formatUnit, ranked, parse };
})();
