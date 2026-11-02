// Achievement registry.
//
// To add a new achievement: append one entry here. The edit form, the badges
// on the board, and the "Hall of Fame" tab all read from this list — no other
// code changes needed. `id` is what gets stored in athletes.achievements[].
// An entry with `earned(athlete)` is computed from the athlete's records instead:
// it is never claimed or stored, so it has no checkbox in the forms.
window.ACHIEVEMENTS = [
  {
    id: 'gripper90kg',
    emoji: '💪',
    name: '90kg Gripper Club',
    short: '90kg Gripper',
    title: 'Gripper Master',
    description: 'The elite few who have closed the 90kg grip strengthener.',
    emptyText: 'No one has conquered the 90kg gripper yet. Be the first!',
  },
  {
    id: 'total1000lb',
    emoji: '🦍',
    name: '1000 lb Club',
    short: '1000 lb Club',
    title: 'Thousand-Pounder',
    description: 'Squat, bench and deadlift adding up to 1000 lb (453.6 kg) or more.',
    emptyText: 'No one has hit a 1000 lb total yet. Be the first!',
    earned: (athlete) => Lifts.value(athlete, 'total') >= 1000 * 0.45359237,
  },
];

window.getAchievement = (id) => window.ACHIEVEMENTS.find((a) => a.id === id);
// Whether an athlete holds an achievement: computed ones by their records, the rest as stored.
window.hasAchievement = (athlete, ach) => ach.earned ? ach.earned(athlete) : (athlete.achievements || []).includes(ach.id);
