// Public changelog, shown under "✨ What's new". Newest release first.
//
// Every release with changes people will notice starts a new entry at the top: the version
// in package.json and on every ?v= in index.html, the release date (YYYY-MM-DD) and one short,
// plain-language line per change. Leave out internal work nobody sees (CI, refactors, docs).
// tests/changelog.test.mjs keeps the top entry in step with the app version.
window.CHANGELOG = [
  {
    version: '3.5.0',
    date: '2026-10-12',
    changes: [
      '🦾 Strict Curl joins Other Lifts: your heaviest strict curl with a bar, in kilograms.',
      'With ⚖️ Bodyweight ranking on, it is divided by bodyweight like the main lifts.',
      'Other Lifts shows its boards two by two, and the TV shows all four side by side.',
    ],
  },
  {
    version: '3.4.0',
    date: '2026-10-12',
    changes: [
      '⚖️ Bodyweight ranking now re-ranks the boards you are looking at, instead of opening a tab of its own.',
      'Lifts and the total are divided by bodyweight. Chill-ups, push-ups and dead hang are multiplied by it, since your body is the weight.',
      'Cardio times stay as they are: running already costs about the same energy per kilogram for everyone.',
    ],
  },
  {
    version: '3.3.0',
    date: '2026-10-12',
    changes: [
      'Bodyweight rankings: turn on ⚖️ Bodyweight ranking to see squat, bench, deadlift and total per kilogram of bodyweight.',
      'Share your bodyweight in My PRs to take part. It is optional, and you can clear it at any time.',
      'This What\'s new list, so you can see what changed.',
      'Smaller TV screens keep every tab on one row.',
    ],
  },
  {
    version: '3.2.0',
    date: '2026-09-30',
    changes: [
      'Athletes who leave are archived instead of deleted, so their records and verified PRs are kept.',
      'Coming back? Sign in with the same GitHub account to bring your athlete back to the boards.',
    ],
  },
  {
    version: '3.1.0',
    date: '2026-09-30',
    changes: [
      'A Latest tab with the newest verified PRs, 🔥 on records set this week and a cheer when a PR is verified while you watch.',
      'Withdraw your own pending requests, and see what changes in each request before you verify it.',
      'Share a link to any tab, and spot your own rows by their highlighter.',
      'Phone keypads work for times: 1.30 means 1:30, and the form shows how a time will be read.',
    ],
  },
  {
    version: '3.0.1',
    date: '2026-09-10',
    changes: [
      'The TV keeps podiums readable at any zoom, gives every page time to be read and recovers by itself after connection trouble.',
    ],
  },
  {
    version: '3.0.0',
    date: '2026-09-08',
    changes: [
      'A fresh layout that fills desktop, phone and TV screens, with the same whiteboard look.',
      'Equal scores share a rank, and an outdated request can no longer overwrite a newer record.',
      'Tabs and dialogs work from the keyboard, and a failed refresh keeps the last board with a Try again button.',
    ],
  },
  {
    version: '2.0.0',
    date: '2026-06-04',
    changes: [
      'The whiteboard moves online: sign in with GitHub, claim your athlete and have a gym buddy verify your PRs.',
      'Added over the summer: Other Lifts and Cardio tabs, progression charts and TV mode.',
    ],
  },
  {
    version: '1.0.0',
    date: '2025-12-11',
    changes: [
      'The first digital whiteboard: squat, bench and deadlift boards with podiums, a combined total and a Hall of Fame.',
    ],
  },
];
