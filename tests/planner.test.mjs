// The office's time zone, so daylight saving changes fall inside the tested weeks.
process.env.TZ = 'Europe/Oslo';
import test from 'node:test';
import assert from 'node:assert/strict';
import { environment } from './helpers.mjs';

const { Planner, document } = environment(['ui', 'lifts', 'avatar', 'planner']);
const day = (key, hour = 12, minute = 0) => { const [y, m, d] = key.split('-').map(Number); return new Date(y, m - 1, d, hour, minute); };
const lift = (key) => Planner.fridayFocus(day(key))?.id ?? null;
const render = (markup) => { const el = document.createElement('div'); el.innerHTML = String(markup); return el; };
const plan = (values = {}) => ({ id: 'p1', owner: 'host', starts_at: day('2026-10-23', 15).toISOString(), activity: 'Bench Press', note: null, plan_joins: [], ...values });
const members = { host: { name: 'Daniel' }, me: { name: 'Alex' }, peer: { name: 'Jens' } };
const ctx = (values = {}) => ({ now: day('2026-10-19', 9), week: 0, plans: [], loading: false, error: false, signedIn: true, configured: true,
  canSee: true, canPlan: true, isAdmin: false, me: 'me', member: (id) => members[id] || { name: 'a member' }, ...values });

test('Fridays rotate squat, bench, deadlift and other lifts by the calendar', () => {
  assert.deepEqual(['2026-10-16', '2026-10-23', '2026-10-30', '2026-11-06', '2026-11-13'].map(lift), ['squat', 'bench', 'deadlift', 'other', 'squat']);
  // Before the start date too, and across daylight saving changes (25 October, 28 March).
  assert.equal(lift('2026-10-09'), 'other');
  assert.equal(lift('2027-03-26'), 'other');
  assert.equal(lift('2027-04-02'), 'squat');
  assert.equal(lift('2026-10-22'), null);
  assert.deepEqual({ ...Planner.fridayFocus(day('2026-11-06')) }, { id: 'other', emoji: '🤸', label: 'Other lifts' });
  assert.equal(Planner.fridayFocus(day('2026-10-23')).label, 'Bench Press');
});

test('the next Friday is today on a Friday and next week at the weekend', () => {
  const at = (now) => { const next = Planner.nextFriday(now); return [Planner.dayKey(next.date), next.daysAway, next.focus.id]; };
  assert.deepEqual(at(day('2026-10-19')), ['2026-10-23', 4, 'bench']);
  assert.deepEqual(at(day('2026-10-23', 21)), ['2026-10-23', 0, 'bench']);
  assert.deepEqual(at(day('2026-10-24')), ['2026-10-30', 6, 'deadlift']);
  assert.equal(Planner.defaultWeek(day('2026-10-24')), 1);
  assert.equal(Planner.defaultWeek(day('2026-10-23')), 0);
});

test('weeks start on Monday at local midnight, also across daylight saving', () => {
  assert.equal(Planner.weekStart(day('2026-10-28'), 0).toString(), new Date(2026, 9, 26).toString());
  assert.equal(Planner.dayKey(Planner.weekStart(day('2026-10-25', 23), 1)), '2026-10-26');
  const { from, to } = Planner.range(day('2026-10-21'));
  assert.equal(from, new Date(2026, 9, 19).toISOString());
  assert.equal(to, new Date(2026, 11, 21).toISOString());
  assert.equal(Planner.weekOf(day('2026-11-05'), day('2026-10-21')), 2);
  assert.equal(Planner.weekOf(day('2027-06-01'), day('2026-10-21')), Planner.WEEKS - 1);
});

test('plan forms are read like the database checks them', () => {
  const now = day('2026-10-19', 12);
  const read = (values) => Planner.readPlan({ date: '2026-10-23', time: '16:30', activity: ' Squat ', note: '  ', ...values }, now);
  assert.deepEqual({ ...read({}) }, { startsAt: day('2026-10-23', 16, 30).toISOString(), activity: 'Squat', note: null });
  assert.equal(read({ note: ' Need a spotter ' }).note, 'Need a spotter');
  // Up to two hours ago ("at the gym now") and 60 days ahead.
  assert.ok(read({ date: '2026-10-19', time: '10:30' }));
  assert.throws(() => read({ date: '2026-10-19', time: '09:59' }), /has passed/);
  assert.throws(() => read({ date: '2026-12-19', time: '12:01' }), /60 days/);
  assert.throws(() => read({ date: '2026-02-31' }), /Pick a day/);
  assert.throws(() => read({ time: '' }), /Pick a time/);
  assert.throws(() => read({ time: '24:00' }), /Pick a time/);
  assert.throws(() => read({ activity: '   ' }), /1 to 60/);
  assert.throws(() => read({ activity: 'x'.repeat(61) }), /1 to 60/);
  assert.throws(() => read({ note: 'x'.repeat(201) }), /200/);
});

test('a session stays open until two hours after it starts', () => {
  const start = day('2026-10-23', 15);
  assert.equal(Planner.isOpen(plan({ starts_at: start.toISOString() }), start.getTime() + Planner.OPEN_MS - 1), true);
  assert.equal(Planner.isOpen(plan({ starts_at: start.toISOString() }), start.getTime() + Planner.OPEN_MS), false);
  // The note's next session is the first one still open, including one under way.
  const plans = [plan({ id: 'later', starts_at: day('2026-10-30', 15).toISOString() }), plan({ id: 'over', starts_at: day('2026-10-19', 6).toISOString() }),
    plan({ id: 'now', starts_at: day('2026-10-19', 8).toISOString() })];
  assert.equal(Planner.nextPlan(plans, day('2026-10-19', 9)).id, 'now');
  assert.equal(Planner.nextPlan(plans, day('2026-10-19', 11)).id, 'later');
  assert.equal(Planner.nextPlan([], day('2026-10-19', 9)), null);
});

test('people come at their own times: the earliest shows, with a + when others come later', () => {
  const at = (h, m = 0) => day('2026-10-23', h, m).toISOString();
  const session = plan({ plan_joins: [{ user_id: 'me', arrives_at: at(15, 30) }, { user_id: 'peer', arrives_at: at(14, 45) }, { user_id: 'x', arrives_at: null }] });
  assert.deepEqual(JSON.parse(JSON.stringify(Planner.arrivals(session).map((a) => [a.user_id, Planner.formatTime(a.at), a.host]))),
    [['peer', '14:45', false], ['host', '15:00', true], ['x', '15:00', false], ['me', '15:30', false]]);
  assert.equal(Planner.timeLabel(session), '14:45+');
  assert.equal(Planner.timeLabel(plan()), '15:00');
  assert.equal(Planner.timeLabel(plan({ plan_joins: [{ user_id: 'me', arrives_at: at(15) }] })), '15:00', 'no + when everyone comes at once');
  assert.equal(Planner.formatTime(Planner.arrivalOf(session, 'me')), '15:30');
  assert.equal(Planner.arrivalOf(session, 'host'), null, 'the host has not joined their own session');
  // The note's next session is the one someone arrives at first.
  const later = plan({ id: 'later', starts_at: at(13), plan_joins: [] });
  assert.equal(Planner.nextPlan([later, session], day('2026-10-23', 9)).id, 'later');
  assert.equal(Planner.nextPlan([plan({ id: 'early', starts_at: at(13, 30) }), session], day('2026-10-23', 9)).id, 'early');
  // The join form's time falls on the session's day, within six hours of its start.
  assert.equal(Planner.readArrival(plan(), '16:15'), at(16, 15));
  assert.equal(Planner.readArrival(plan(), '09:00'), at(9));
  assert.throws(() => Planner.readArrival(plan(), '08:59'), /six hours/);
  assert.throws(() => Planner.readArrival(plan(), '21:01'), /six hours/);
  assert.throws(() => Planner.readArrival(plan(), ''), /Pick a time/);
});

test('a session lists who comes when, earliest first, with the host marked', () => {
  const at = (h, m = 0) => day('2026-10-23', h, m).toISOString();
  const view = render(Planner.session(plan({ activity: '<i>Bench</i>', note: 'Chalk', plan_joins: [{ user_id: 'me', arrives_at: at(15, 30) }, { user_id: 'peer', arrives_at: at(14, 45) }] }), ctx()));
  assert.match(view.querySelector('.session-title').textContent, /<i>Bench<\/i>/);
  assert.match(view.querySelector('.session-when').textContent, /Fri 23 Oct · 14:45\+/);
  assert.deepEqual([...view.querySelectorAll('.session-people li')].map((li) => li.textContent.replace(/\s+/g, ' ').trim()),
    ['14:45 Jens', '15:00 Daniel host', '15:30 You']);
  assert.ok(view.querySelector('.session-people li.is-me'));
  assert.match(render(Planner.session(null, ctx())).textContent, /no longer planned/);
});

test('each Friday\'s lift is a session with no host that members join at their own time', () => {
  const fri = (user_id, h, m = 0) => ({ day: '2026-10-23', user_id, arrives_at: day('2026-10-23', h, m).toISOString(), created_at: `${h}` });
  const joins = [fri('peer', 15, 30), fri('me', 15), { day: '2026-10-30', user_id: 'host', arrives_at: day('2026-10-30', 9).toISOString() }];
  const session = Planner.fridayPlan(day('2026-10-23'), joins);
  assert.deepEqual(JSON.parse(JSON.stringify({ ...session, plan_joins: session.plan_joins.length })),
    { id: 'friday-2026-10-23', friday: '2026-10-23', owner: null, starts_at: day('2026-10-23', 0).toISOString(), activity: 'Bench Press', emoji: '🏋️', note: null, plan_joins: 2 });
  assert.equal(Planner.fridayPlan(day('2026-10-22'), joins), null);
  assert.equal(Planner.planById('friday-2026-10-23', [], joins).friday, '2026-10-23');
  assert.equal(Planner.planById('friday-2026-10-22', [], joins), null);
  assert.equal(Planner.planById('p1', [plan()], joins).id, 'p1');
  // No host: the earliest joiner sets the time, and before anyone joins there is none.
  assert.equal(Planner.timeLabel(session), '15:00+');
  assert.equal(Planner.timeLabel(Planner.fridayPlan(day('2026-11-06'), joins)), '');
  // Open all that Friday; any time that day.
  assert.equal(Planner.isOpen(session, day('2026-10-23', 23, 59).getTime()), true);
  assert.equal(Planner.isOpen(session, day('2026-10-24', 0).getTime()), false);
  assert.equal(Planner.readArrival(session, '07:00'), day('2026-10-23', 7).toISOString());
  // The planner's Friday card lists who's in and lets members join or change their time.
  const week = render(Planner.week(ctx({ fridayJoins: joins })));
  const card = week.querySelector('[data-day="2026-10-23"] .friday-card');
  assert.match(card.querySelector('.friday-chip-label').textContent, /Friday lift · 15:00\+/);
  assert.match(card.querySelector('.friday-card-who').textContent, /you and Jens/);
  assert.equal(card.querySelector('.plan-join').textContent, '✓ In · 15:00');
  assert.ok(card.classList.contains('joined'));
  assert.equal(render(Planner.week(ctx({ fridayJoins: [] }))).querySelector('.friday-card .plan-join').textContent, '🙋 I\'m in');
  assert.equal(render(Planner.week(ctx({ fridayJoins: joins, canSee: false, canPlan: false }))).querySelector('.friday-card'), null);
  // Its session view has no host, and says so when no one has joined yet.
  const view = render(Planner.session(session, ctx()));
  assert.match(view.querySelector('.session-eyebrow').textContent, /Friday lift/);
  assert.deepEqual([...view.querySelectorAll('.session-people li')].map((li) => li.textContent.replace(/\s+/g, ' ').trim()), ['15:00 You', '15:30 Jens']);
  assert.match(render(Planner.session(Planner.fridayPlan(day('2026-11-06'), []), ctx())).textContent, /No one has said they're coming yet/);
});

test('activities get the emoji of the exercise they name', () => {
  assert.deepEqual(['Squat', 'heavy bench day', 'Deadlift', 'Dead hang', 'Other lifts', 'Run 5 km', 'Yoga'].map(Planner.activityEmoji),
    ['🦵', '🏋️', '💀', '🐒', '🤸', '🏃', '💪']);
  assert.ok(Planner.suggestions().includes('Other lifts') && Planner.suggestions().includes('Strict Curl'));
});

test('the Friday note names the lift, and members also see the next session and who is in', () => {
  const now = day('2026-10-19', 9);
  const member = (id) => members[id];
  const note = (values) => render(Planner.fridayNote({ now, canSee: true, me: 'me', member, ...values }));
  const visitor = render(Planner.fridayNote({ now }));
  assert.match(visitor.querySelector('.next-lift-name').textContent, /Bench Press/);
  assert.match(visitor.querySelector('.next-lift-eyebrow').textContent, /Fri 23 Oct · in 4 days/);
  assert.equal(visitor.querySelector('.next-session'), null);
  assert.ok(visitor.querySelector('.btn[data-action="open-planner"]'));
  const next = note({ plan: plan({ starts_at: day('2026-10-20', 11, 30).toISOString(), activity: '<b>Squat</b>', plan_joins: [{ user_id: 'me' }, { user_id: 'peer' }] }) });
  const session = next.querySelector('button.next-session');
  assert.equal(session.dataset.id, 'p1');
  assert.match(session.textContent, /Next session · tomorrow 11:30/);
  assert.match(session.querySelector('.next-session-what').textContent, /<b>Squat<\/b>/);
  assert.match(session.querySelector('.next-session-who').textContent, /with Daniel · 🙋 2 in/);
  // A session before Friday leads the note, and the Friday lift shrinks to a labelled emoji.
  assert.ok(next.firstElementChild.classList.contains('lead'));
  const compact = next.querySelector('.next-lift-main.compact');
  assert.equal(compact.textContent, 'Friday🏋️');
  assert.equal(compact.getAttribute('aria-label'), 'Friday lift: Bench Press');
  assert.equal(next.querySelector('#nextLiftTitle'), null);
  // A session on Friday itself leaves the Friday lift in front, at full size.
  const friday = note({ plan: plan() });
  assert.ok(friday.firstElementChild.matches('.next-lift-main:not(.compact)'));
  assert.ok(!friday.querySelector('.next-session').classList.contains('lead'));
  assert.match(note({ plan: plan({ owner: 'me', starts_at: day('2026-10-19', 8).toISOString() }) }).querySelector('.next-session').textContent, /now[\s\S]*Your session · no one in yet/);
  // Without a planned session the note shows only the Friday lift, with a way to join it.
  const quiet = note({ plan: null });
  assert.equal(quiet.querySelector('.next-session'), null);
  assert.equal(quiet.querySelector('.next-friday-who').textContent, '🙋 Join');
  assert.equal(quiet.querySelector('.next-friday-who').dataset.id, 'friday-2026-10-23');
  const fri = (user_id, h, m = 0) => ({ day: '2026-10-23', user_id, arrives_at: day('2026-10-23', h, m).toISOString() });
  assert.equal(note({ fridayJoins: [fri('peer', 15, 30), fri('host', 15)] }).querySelector('.next-friday-who').textContent, 'from 15:00 · 🙋 2 in');
  assert.equal(note({ fridayJoins: [fri('peer', 15), fri('me', 16)] }).querySelector('.next-friday-who').textContent, '✓ In at 16:00 · 🙋 2 in');
  assert.equal(render(Planner.fridayNote({ now, fridayJoins: [fri('peer', 15)] })).querySelector('.next-friday-who'), null, 'visitors see no joins');
  assert.equal(note({ plan: plan(), error: true }).querySelector('.next-session'), null, 'no session claims when the plans did not load');
  assert.match(render(Planner.fridayNote({ now: day('2026-10-23') })).textContent, /today/);
  assert.match(note({ plan: plan({ starts_at: day('2026-10-22', 15).toISOString() }) }).querySelector('.next-session').textContent, /Next session · Thu 15:00/,
    'within a week the weekday is enough');
});

test('the TV header says the same as the note, and a signed-out TV only the Friday lift', () => {
  const now = day('2026-10-19', 9);
  const member = (id) => members[id];
  const tv = (values) => render(Planner.tvNote({ now, me: 'me', member, ...values }));
  assert.match(render(Planner.tvNote({ now: day('2026-10-24') })).textContent, /Friday.*Deadlift/);
  const visitor = tv({ plan: plan() });
  assert.equal(visitor.querySelector('.tv-session'), null, 'plans stay with members');
  const earlier = tv({ canSee: true, plan: plan({ starts_at: day('2026-10-20', 11, 30).toISOString(), activity: 'Squat', plan_joins: [{ user_id: 'peer' }] }) });
  assert.ok(earlier.querySelector('.tv-note.session-first'));
  assert.match(earlier.querySelector('.tv-session').textContent, /Next · tomorrow 11:30[\s\S]*Squat[\s\S]*🙋 1 in/);
  assert.equal(earlier.querySelector('.tv-friday.compact').textContent.replace(/\s+/g, ''), 'Friday🏋️');
  assert.match(tv({ canSee: true, fridayJoins: [{ day: '2026-10-23', user_id: 'peer', arrives_at: day('2026-10-23', 15).toISOString() }] })
    .querySelector('.tv-friday').textContent, /Bench Press[\s\S]*from 15:00 · 🙋 1 in/);
  const friday = tv({ canSee: true, plan: plan() });
  assert.ok(friday.querySelector('.tv-note.friday-first .tv-friday:first-child:not(.compact)'));
  assert.match(friday.querySelector('.tv-session').textContent, /Next · Fri 15:00/);
});

test('the boards mark this Friday\'s lift: a main lift by its board, other lifts by one line', () => {
  assert.deepEqual({ ...Planner.fridayBoard(day('2026-10-19')) }, { id: 'bench', label: 'Friday lift', title: 'The Friday lift, Fri 23 Oct' });
  assert.equal(Planner.fridayBoard(day('2026-10-23')).label, 'Today\'s lift');
  assert.equal(Planner.otherCallout(day('2026-10-19')), '');
  assert.match(render(Planner.otherCallout(day('2026-11-02'))).textContent, /Friday lift Pick any of these on Fri 6 Nov/);
  assert.match(render(Planner.otherCallout(day('2026-11-06'))).textContent, /Today's lift Pick any of these today/);
});

test('the week shows plans to members, escaped, with join, edit and remove controls', () => {
  const plans = [
    plan({ id: 'theirs', activity: '<img src=x onerror=alert(1)>', note: '<b>spotter</b>', plan_joins: [{ user_id: 'peer', created_at: '2' }, { user_id: 'me', created_at: '1' }] }),
    plan({ id: 'mine', owner: 'me', starts_at: day('2026-10-20', 11, 30).toISOString(), activity: 'Upper body' }),
    plan({ id: 'over', starts_at: day('2026-10-19', 6).toISOString(), activity: 'Run' }),
  ];
  const week = render(Planner.week(ctx({ plans })));
  assert.equal(week.querySelectorAll('img').length, 0);
  assert.equal(week.querySelectorAll('.planner-day').length, 7);
  assert.equal(week.querySelector('.planner-day.today').dataset.day, '2026-10-19');
  assert.match(week.querySelector('[data-day="2026-10-23"] .friday-chip').textContent, /Bench Press/);
  const theirs = week.querySelector('.plan-join[data-id="theirs"]').closest('.plan-card');
  assert.equal(theirs.querySelector('.plan-time').textContent, '15:00');
  assert.match(theirs.querySelector('.plan-activity').textContent, /<img src=x/);
  assert.match(theirs.querySelector('.plan-joiners').textContent, /you and Jens/);
  assert.equal(theirs.querySelector('.plan-join').textContent, '✓ In · 15:00');
  assert.equal(theirs.querySelector('[data-action="plan-delete"]'), null, 'only its owner or an admin removes it');
  const mine = week.querySelector('[data-day="2026-10-20"] .plan-card');
  assert.ok(mine.querySelector('[data-action="plan-edit"]') && mine.querySelector('[data-action="plan-delete"]'));
  assert.equal(mine.querySelector('.plan-join'), null);
  // A session that is over can't be joined; past days take no new plans.
  assert.equal(week.querySelector('.plan-card.over .plan-join'), null);
  assert.equal(week.querySelector('[data-action="plan-add"][data-id="2026-10-19"]')?.dataset.id, '2026-10-19');
  assert.equal(render(Planner.week(ctx({ plans, now: day('2026-10-20', 9) }))).querySelector('[data-action="plan-add"][data-id="2026-10-19"]'), null);
  // Admins can remove anyone's plan.
  assert.ok(render(Planner.week(ctx({ plans, isAdmin: true }))).querySelector('.plan-remove[data-id="theirs"]'));
});

test('visitors and members awaiting a spot see the Fridays but no plans', () => {
  const plans = [plan()];
  const visitor = render(Planner.week(ctx({ plans, signedIn: false, canSee: false, canPlan: false })));
  assert.equal(visitor.querySelectorAll('.plan-card').length, 0);
  assert.ok(visitor.querySelector('.planner-notice [data-action="sign-in"]'));
  assert.ok(visitor.querySelector('.friday-chip'));
  assert.equal(visitor.querySelector('[data-action="plan-add"]'), null);
  const waiting = render(Planner.week(ctx({ plans, canSee: false, canPlan: false })));
  assert.match(waiting.querySelector('.planner-notice').textContent, /Once an admin approves/);
  const failed = render(Planner.week(ctx({ plans, error: true })));
  assert.equal(failed.querySelectorAll('.plan-card').length, 0);
  assert.match(failed.querySelector('.planner-notice.warning').textContent, /could not load/);
  // The week buttons stop at this week and at the last week the planner loads.
  assert.equal(render(Planner.week(ctx())).querySelector('[data-action="planner-week"][data-id="-1"]').hasAttribute('disabled'), true);
  assert.equal(render(Planner.week(ctx({ week: Planner.WEEKS - 1 }))).querySelector('[data-action="planner-week"][data-id="1"]').hasAttribute('disabled'), true);
});
