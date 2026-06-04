// Achievement registry.
//
// To add a new achievement: append one entry here. The edit form, the badges
// on the board, and the "Hall of Fame" tab all read from this list — no other
// code changes needed. `id` is what gets stored in athletes.achievements[].
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
];

window.getAchievement = (id) => window.ACHIEVEMENTS.find((a) => a.id === id);
