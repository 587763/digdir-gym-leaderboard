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

// Seconds → "m:ss" (e.g. 95 → "1:35").
window.formatLiftTime = (seconds) => {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

// "m:ss" → whole seconds (e.g. "6:30" → 390). Also accepts a bare number of
// seconds ("390") so old habits still work. Returns 0 for blank/unparseable.
window.parseLiftTime = (input) => {
  const str = String(input ?? '').trim();
  if (!str) return 0;
  const m = str.match(/^(\d+):([0-5]?\d(?:\.\d+)?)$/);
  if (m) return Math.max(0, Math.round(parseInt(m[1], 10) * 60 + parseFloat(m[2])));
  const n = parseFloat(str);
  return Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0;
};
