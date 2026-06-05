// "Other lifts" registry — extra lifts beyond the three fixed main columns
// (squat/bench/deadlift). These live in the athletes.lifts jsonb map, so adding
// one needs NO schema change.
//
// To add a lift: append one entry here. The "Other Lifts" tab (board sections),
// the "My PRs" form, and the admin form all read from this list — no other code
// changes. `id` is the jsonb key stored in athletes.lifts; `unit` decides
// formatting & input: 'kg' (numeric, one decimal) or 'time' (whole seconds,
// shown mm:ss, where LONGER ranks higher).
window.OTHER_LIFTS = [
  {
    id: 'deadhang',
    emoji: '🐒',
    label: 'Dead Hang',
    unit: 'time',
  },
];

window.getOtherLift = (id) => window.OTHER_LIFTS.find((l) => l.id === id);

// Seconds → "m:ss" (e.g. 95 → "1:35").
window.formatLiftTime = (seconds) => {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
