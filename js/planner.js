// The Friday lift rotation and the gym planner. Pure rules and markup from plain data, like
// BoardView; app.js owns the DOM, the data and the dialogs.
//
// Fridays rotate by the calendar: squat, bench, deadlift, then other lifts, one each Friday,
// starting with squat on ROTATION.start. A Friday without a session still uses up its turn.
// To shift the rotation (say, to repeat a lift after a holiday), move `start` by a week.
//
// Dates are the viewer's local calendar days (the office's time zone); a plan's starts_at is
// an instant. The planner opens from the Friday note, in a dialog. Planner context (ctx): { now: Date, week: weeks after this one,
//   plans: [{ id, owner, starts_at, activity, note, plan_joins: [{ user_id, arrives_at, created_at }] }],
//   loading, error, signedIn, canSee (members on the board and admins, as in SQL can_plan()),
//   canPlan, isAdmin, me: user id, member(userId) → { name, athlete } }
window.Planner = (() => {
  const { html } = UI;
  const ROTATION = { start: '2026-10-16', order: ['squat', 'bench', 'deadlift', 'other'] };
  const OPEN_MS = 2 * 3600000; // joinable until two hours after the start (matching SQL)
  const ARRIVAL_MS = 6 * 3600000; // joiners come within six hours of the start (matching SQL)
  const AHEAD_DAYS = 60;       // plans reach at most this far ahead (matching SQL)
  const WEEKS = 9;             // the planner shows this week and the eight after it
  const ACTIVITY_MAX = 60;
  const NOTE_MAX = 200;
  const LOCALE = 'en-GB';
  const icon = (emoji) => html`<span aria-hidden="true">${emoji}</span>`;
  const avatar = (person, size = 30) => UI.raw(window.renderAvatar(person.athlete || { name: person.name }, size, { decorative: true }));

  // --- calendar days ---------------------------------------------------------
  const pad = (n) => String(n).padStart(2, '0');
  const dayKey = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const fromKey = (key) => { const [y, m, d] = key.split('-').map(Number); return new Date(y, m - 1, d); };
  // Local midnight n days later; calendar arithmetic, so daylight saving changes can't skew it.
  const addDays = (date, n) => new Date(date.getFullYear(), date.getMonth(), date.getDate() + n);
  const startOfDay = (date) => addDays(date, 0);
  // Whole days since the epoch for a calendar day, independent of the time zone.
  const dayNumber = (date) => Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86400000;
  const isFriday = (date) => date.getDay() === 5;

  // --- the Friday rotation -----------------------------------------------------
  const focus = (id) => {
    const group = Lifts.groups.find((g) => g.id === id);
    const lift = group ? null : Lifts.get(id);
    return { id, emoji: (group || lift).emoji, label: group ? group.label : lift.label };
  };
  // What a Friday is for; null on any other day.
  function fridayFocus(date) {
    if (!isFriday(date)) return null;
    const weeks = Math.round((dayNumber(date) - dayNumber(fromKey(ROTATION.start))) / 7);
    const { order } = ROTATION;
    return focus(order[((weeks % order.length) + order.length) % order.length]);
  }
  // The coming Friday (today on a Friday) and its lift.
  function nextFriday(now = new Date()) {
    const daysAway = (5 - now.getDay() + 7) % 7;
    const date = addDays(now, daysAway);
    return { date, daysAway, focus: fridayFocus(date) };
  }

  // --- weeks -------------------------------------------------------------------
  const monday = (date) => addDays(date, -((date.getDay() + 6) % 7));
  const weekStart = (now, week) => addDays(monday(now), 7 * week);
  // At the weekend the planner opens on the coming week.
  const defaultWeek = (now = new Date()) => (now.getDay() === 0 || now.getDay() === 6 ? 1 : 0);
  const clampWeek = (week) => Math.min(WEEKS - 1, Math.max(0, week));
  // The span of plans to load: every week the planner can show.
  const range = (now = new Date()) => ({ from: weekStart(now, 0).toISOString(), to: weekStart(now, WEEKS).toISOString() });
  const weekOf = (date, now = new Date()) => clampWeek(Math.round((dayNumber(monday(date)) - dayNumber(monday(now))) / 7));

  // --- plans -------------------------------------------------------------------
  const isOpen = (plan, now = Date.now()) => Date.parse(plan.starts_at) + OPEN_MS > now;
  const joiners = (plan) => [...(plan.plan_joins || [])].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
    .map((j) => j.user_id);
  // The last day a plan may start on (partly: plans reach AHEAD_DAYS from this moment).
  const lastDay = (now) => addDays(now, AHEAD_DAYS);
  // Who comes when, earliest first: the host at the start, everyone who joined at their own time.
  const arrivals = (plan) => [{ user_id: plan.owner, at: Date.parse(plan.starts_at), host: true },
    ...(plan.plan_joins || []).map((j) => ({ user_id: j.user_id, at: Date.parse(j.arrives_at ?? plan.starts_at), host: false }))]
    .sort((a, b) => a.at - b.at || b.host - a.host);
  const earliest = (plan) => arrivals(plan)[0].at;
  // When a joiner comes, or null when they haven't joined.
  const arrivalOf = (plan, userId) => arrivals(plan).find((a) => a.user_id === userId && !a.host)?.at ?? null;
  const byEarliest = (a, b) => earliest(a) - earliest(b);
  // The first session still open (one under way counts), for the Friday note.
  const nextPlan = (plans, now = new Date()) => [...(plans || [])].filter((p) => isOpen(p, now.getTime())).sort(byEarliest)[0] ?? null;

  // "Squat" and "bench day" find their exercise's emoji; anything else gets a flexed arm.
  function activityEmoji(text) {
    const words = String(text).toLocaleLowerCase();
    const known = [...Lifts.all.map((e) => [e.emoji, e.label, e.id]), ...Lifts.groups.map((g) => [g.emoji, g.label, g.id]),
      ['🏃', 'run'], ['🏃', 'jog'], ['🚴', 'bike'], ['🚴', 'cycl'], ['🧘', 'stretch'], ['🧘', 'mobility']];
    return known.find(([, ...names]) => names.some((name) => words.includes(name.toLocaleLowerCase())))?.[0] || '💪';
  }
  // Suggestions for the activity field: the Friday lifts, every exercise, then a few general ones.
  const suggestions = () => [...new Set([...ROTATION.order.map((id) => focus(id).label), ...Lifts.all.map((e) => e.label),
    'Upper body', 'Lower body', 'Full body', 'Cardio', 'Mobility'])];

  // Form fields → { startsAt (ISO), activity, note }, or an Error saying what to fix.
  function readPlan({ date, time, activity, note }, now = new Date()) {
    const day = /^\d{4}-\d{2}-\d{2}$/.test(date || '') ? fromKey(date) : null;
    const clock = String(time || '').match(/^(\d{2}):(\d{2})/);
    if (!day || dayKey(day) !== date) throw new Error('Pick a day.');
    if (!clock || Number(clock[1]) > 23 || Number(clock[2]) > 59) throw new Error('Pick a time, like 16:30.');
    const start = new Date(day.getFullYear(), day.getMonth(), day.getDate(), Number(clock[1]), Number(clock[2]));
    if (start.getTime() < now.getTime() - OPEN_MS) throw new Error('That time has passed. Pick a time from now on.');
    if (start.getTime() > now.getTime() + AHEAD_DAYS * 86400000) throw new Error(`Plans reach at most ${AHEAD_DAYS} days ahead.`);
    const what = String(activity || '').trim();
    if (!what || what.length > ACTIVITY_MAX) throw new Error(`Say what you'll do, in 1 to ${ACTIVITY_MAX} characters.`);
    const remark = String(note || '').trim();
    if (remark.length > NOTE_MAX) throw new Error(`Keep the note to ${NOTE_MAX} characters.`);
    return { startsAt: start.toISOString(), activity: what, note: remark || null };
  }
  // The join form's time → an instant on the session's day, or an Error saying what to fix.
  function readArrival(plan, time) {
    const clock = String(time || '').match(/^(\d{2}):(\d{2})/);
    if (!clock || Number(clock[1]) > 23 || Number(clock[2]) > 59) throw new Error('Pick a time, like 16:30.');
    const start = new Date(plan.starts_at);
    const at = new Date(start.getFullYear(), start.getMonth(), start.getDate(), Number(clock[1]), Number(clock[2]));
    if (Math.abs(at - start) > ARRIVAL_MS) throw new Error('Pick a time within six hours of the session\'s start.');
    return at.toISOString();
  }

  // --- labels ------------------------------------------------------------------
  const formatDay = (date) => date.toLocaleDateString(LOCALE, { weekday: 'short', day: 'numeric', month: 'short' });
  const formatTime = (when) => new Date(when).toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit' });
  // The earliest arrival: "13:00", or "13:00+" when someone comes later.
  const timeLabel = (plan) => {
    const times = arrivals(plan).map((a) => a.at);
    return `${formatTime(times[0])}${times.some((t) => t > times[0]) ? '+' : ''}`;
  };
  const timeValue = (iso) => { const d = new Date(iso); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  const whenLabel = (daysAway, date) => daysAway === 0 ? 'today' : daysAway === 1 ? 'tomorrow' : `${formatDay(date)} · in ${daysAway} days`;
  // "now", "today 16:00+", "tomorrow 11:30", "Thu 17:45" this week or "Thu 29 Oct 17:45", from
  // the earliest arrival.
  function sessionWhen(plan, now) {
    const start = new Date(earliest(plan));
    if (start <= now) return 'now';
    const days = dayNumber(start) - dayNumber(now);
    const day = days === 0 ? 'today' : days === 1 ? 'tomorrow'
      : days < 7 ? start.toLocaleDateString(LOCALE, { weekday: 'short' }) : formatDay(start);
    return `${day} ${timeLabel(plan)}`;
  }
  const names = (list) => list.length <= 1 ? list.join('') : `${list.slice(0, -1).join(', ')} and ${list.at(-1)}`;
  function weekTitle(week, start) {
    const end = addDays(start, 6);
    const span = start.getMonth() === end.getMonth()
      ? `${start.getDate()}–${end.toLocaleDateString(LOCALE, { day: 'numeric', month: 'short' })}`
      : `${start.toLocaleDateString(LOCALE, { day: 'numeric', month: 'short' })} – ${end.toLocaleDateString(LOCALE, { day: 'numeric', month: 'short' })}`;
    return { name: week === 0 ? 'This week' : week === 1 ? 'Next week' : `In ${week} weeks`, span };
  }

  // --- markup ------------------------------------------------------------------
  // What the Friday note and the TV header show: this Friday's lift, and for members the next
  // planned session, which comes first (the Friday lift shrinking to a labelled emoji) when it
  // is on a day before Friday. ctx: { now, canSee, error, plan, me, member }.
  function noteState({ now = new Date(), canSee = false, error = false, plan = null, me = null, member } = {}) {
    const next = nextFriday(now);
    const shown = canSee && !error;
    const going = plan ? joiners(plan).length : 0;
    return { now, next, shown, plan: shown ? plan : null, first: shown && !!plan && earliest(plan) < next.date.getTime(),
      who: plan && (plan.owner === me ? 'Your session' : `with ${member(plan.owner).name}`),
      count: going ? `🙋 ${going} in` : 'no one in yet' };
  }

  // The sticky note by the member controls, with the way into the planner.
  function fridayNote(ctx = {}) {
    const { now, next, shown, plan, first, who, count } = noteState(ctx);
    const session = () => {
      if (!plan) return html`<div class="next-session"><p class="next-lift-eyebrow">Next session</p><p class="next-session-what">Nothing planned yet</p></div>`;
      return html`<button type="button" class="next-session${first && ' lead'}" data-action="open-planner" data-id="${plan.id}" aria-label="Next session, ${sessionWhen(plan, now)}: ${plan.activity}, ${who}, ${count}. See who comes when">
        <span class="next-lift-eyebrow">Next session · ${sessionWhen(plan, now)}</span>
        <span class="next-session-what">${icon(activityEmoji(plan.activity))} ${plan.activity}</span>
        <span class="next-session-who">${who} · ${count}</span>
      </button>`;
    };
    const friday = first
      ? html`<span class="next-lift-main compact" role="img" aria-label="Friday lift: ${next.focus.label}" title="Friday lift, ${formatDay(next.date)}: ${next.focus.label}"><span class="next-lift-eyebrow">Friday</span><span class="next-lift-emoji">${next.focus.emoji}</span></span>`
      : html`<div class="next-lift-main">
          <h2 class="next-lift-eyebrow" id="nextLiftTitle">Friday lift · <span class="next-lift-when">${whenLabel(next.daysAway, next.date)}</span></h2>
          <p class="next-lift-name">${icon(next.focus.emoji)} ${next.focus.label}</p>
        </div>`;
    return html`${first ? html`${session()}${friday}` : html`${friday}${shown && session()}`}
      <button type="button" class="btn btn-secondary btn-small" data-action="open-planner">📅 Planner</button>`;
  }

  // Marks for the boards: the board of this Friday's lift gets a sticker (BoardView), and
  // when it is other lifts, their tab gets one line instead of a sticker on every board.
  function fridayBoard(now = new Date()) {
    const next = nextFriday(now);
    return { id: next.focus.id, label: next.daysAway === 0 ? 'Today\'s lift' : 'Friday lift', title: `The Friday lift, ${formatDay(next.date)}` };
  }
  function otherCallout(now = new Date()) {
    const next = nextFriday(now);
    if (next.focus.id !== 'other') return '';
    return html`<span class="friday-tag">📅 ${next.daysAway === 0 ? 'Today\'s lift' : 'Friday lift'}</span> ${next.daysAway === 0 ? 'Pick any of these today.' : `Pick any of these on ${formatDay(next.date)}.`}`;
  }

  // The same in one line for the TV header: no controls, readable across the room. A TV that
  // is signed out (as office screens usually are) sees only the Friday lift.
  function tvNote(ctx = {}) {
    const { now, next, plan, first, count } = noteState(ctx);
    const friday = first
      ? html`<span class="tv-part tv-friday compact"><span class="tv-next-lift-when">Friday</span> ${next.focus.emoji}</span>`
      : html`<span class="tv-part tv-friday"><span class="tv-next-lift-when">${next.daysAway === 0 ? 'Today' : 'Friday'}</span> ${icon(next.focus.emoji)} ${next.focus.label}</span>`;
    const session = plan && html`<span class="tv-part tv-session${first && ' lead'}"><span class="tv-next-lift-when">Next · ${sessionWhen(plan, now)}</span>
      <span class="tv-session-what">${icon(activityEmoji(plan.activity))} ${plan.activity}</span><span class="tv-session-who">${count}</span></span>`;
    return html`<span class="tv-note${first ? ' session-first' : ' friday-first'}">${first ? html`${session}${friday}` : html`${friday}${session}`}</span>`;
  }

  function planCard(plan, ctx) {
    const now = ctx.now.getTime();
    const open = isOpen(plan, now);
    const host = ctx.member(plan.owner);
    const going = joiners(plan);
    const mine = plan.owner === ctx.me;
    const joined = going.includes(ctx.me);
    const when = `${formatDay(new Date(plan.starts_at))} ${formatTime(plan.starts_at)}`;
    const others = going.map((id) => (id === ctx.me ? 'you' : ctx.member(id).name));
    const removeLabel = `Remove ${mine ? 'your' : `${host.name}'s`} ${plan.activity} session, ${when}`;
    // The title and I'm in open the session: who comes when, and the time you'll come.
    return html`<li class="plan-card${mine && ' mine'}${joined && ' joined'}${!open && ' over'}" data-plan="${plan.id}">
      ${!mine && ctx.isAdmin && html`<button type="button" class="plan-remove" data-action="plan-delete" data-id="${plan.id}" aria-label="${removeLabel}" title="Remove (admin)">&times;</button>`}
      <p class="plan-what"><time class="plan-time" datetime="${new Date(earliest(plan)).toISOString()}">${timeLabel(plan)}</time>
        <button type="button" class="plan-activity" data-action="plan-open" data-id="${plan.id}" title="Who comes when">${icon(activityEmoji(plan.activity))} ${plan.activity}</button></p>
      ${plan.note && html`<p class="plan-note">${plan.note}</p>`}
      <p class="plan-people"><span class="plan-host">${avatar(host)}<span>${mine ? 'You' : host.name}</span></span>${going.length > 0
        && html`<span class="plan-joiners">+ ${names(others)}</span>`}</p>
      ${ctx.canPlan && (mine || open) && html`<div class="plan-actions">${!mine
        && (joined
          ? html`<button type="button" class="btn btn-small plan-join joined" data-action="plan-open" data-id="${plan.id}" aria-label="You're in at ${formatTime(arrivalOf(plan, ctx.me))}: change your time or leave ${host.name}'s ${plan.activity} session">✓ In · ${formatTime(arrivalOf(plan, ctx.me))}</button>`
          : html`<button type="button" class="btn btn-small plan-join" data-action="plan-open" data-id="${plan.id}" aria-label="I'm in: ${plan.activity} with ${host.name}, ${when}. Choose your time">🙋 I'm in</button>`)}${
        mine && open && html`<button type="button" class="btn btn-ghost btn-small" data-action="plan-edit" data-id="${plan.id}" aria-label="Change your ${plan.activity} session, ${when}">Edit</button>`}${
        mine && html`<button type="button" class="btn btn-ghost btn-small" data-action="plan-delete" data-id="${plan.id}" aria-label="${removeLabel}">Remove</button>`}</div>`}
    </li>`;
  }

  // The session view in the planner: what, when, and who comes when, earliest first. The join
  // form below it is static markup (app.js), so a refresh never loses a time being typed.
  function session(plan, ctx) {
    if (!plan) return html`<h3 class="session-title" id="planSessionTitle" tabindex="-1">This session is no longer planned.</h3>`;
    return html`<h3 class="session-title" id="planSessionTitle" tabindex="-1">${icon(activityEmoji(plan.activity))} ${plan.activity}</h3>
      <p class="session-when">${formatDay(new Date(plan.starts_at))} · ${timeLabel(plan)}${!isOpen(plan, ctx.now.getTime()) && ' · over'}</p>
      ${plan.note && html`<p class="plan-note">${plan.note}</p>`}
      <h4 class="form-section-title">Who comes when</h4>
      <ol class="session-people">${arrivals(plan).map((arrival) => {
        const person = ctx.member(arrival.user_id);
        return html`<li${arrival.user_id === ctx.me && UI.raw(' class="is-me"')}><time class="plan-time" datetime="${new Date(arrival.at).toISOString()}">${formatTime(arrival.at)}</time>
          ${avatar(person, 28)}<span class="session-name">${arrival.user_id === ctx.me ? 'You' : person.name}</span>${arrival.host && html` <span class="tag tag-peer">host</span>`}</li>`;
      })}</ol>`;
  }

  // Why plans aren't listed, when they aren't.
  function notice(ctx) {
    if (!ctx.signedIn) {
      return html`<div class="planner-notice"><p><strong>🔒 Plans are for members on the board.</strong> Sign in and claim your spot to see who's training when, plan your own sessions and join others.</p>
        <button type="button" class="btn btn-primary" data-action="sign-in"${!ctx.configured && UI.raw(' disabled')}>Sign in with GitHub</button></div>`;
    }
    if (!ctx.canSee) return html`<div class="planner-notice"><p><strong>🔒 Plans are for members on the board.</strong> Once an admin approves your spot, you'll see who's training when and can join them.</p></div>`;
    if (ctx.error) return html`<div class="planner-notice warning" role="status"><p>The planner could not load the plans. The boards still work; try again in a moment.</p></div>`;
    if (ctx.loading) return html`<p class="planner-loading">Loading plans…</p>`;
    return '';
  }

  // The planner dialog's week: seven days, each with its sessions; Fridays carry their lift.
  function week(ctx) {
    const now = ctx.now;
    const today = startOfDay(now);
    const start = weekStart(now, ctx.week);
    const title = weekTitle(ctx.week, start);
    const showPlans = ctx.canSee && !ctx.error;
    const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));
    const day = (date) => {
      const key = dayKey(date);
      const past = date < today;
      const friday = fridayFocus(date);
      const plans = showPlans ? (ctx.plans || []).filter((p) => dayKey(new Date(p.starts_at)) === key).sort(byEarliest) : [];
      const label = date.toLocaleDateString(LOCALE, { weekday: 'long', day: 'numeric', month: 'long' });
      const canAdd = ctx.canPlan && showPlans && !past && date <= lastDay(now);
      return html`<li class="planner-day${past && ' past'}${key === dayKey(today) && ' today'}${friday && ' friday'}" data-day="${key}">
        <h4 class="planner-day-head"><span class="planner-weekday">${date.toLocaleDateString(LOCALE, { weekday: 'short' })}</span>
          <span class="planner-date">${date.toLocaleDateString(LOCALE, { day: 'numeric', month: 'short' })}</span>${key === dayKey(today) && html`<span class="planner-today">today</span>`}</h4>
        ${friday && html`<p class="friday-chip"><span class="friday-chip-label">Friday lift</span> ${icon(friday.emoji)} ${friday.label}</p>`}
        ${plans.length > 0 ? html`<ul class="planner-plans">${plans.map((p) => planCard(p, ctx))}</ul>`
          : showPlans && !ctx.loading && !canAdd && html`<p class="planner-empty">Nothing planned</p>`}
        ${canAdd && html`<button type="button" class="planner-add" data-action="plan-add" data-id="${key}" aria-label="Plan a session on ${label}">+ Add</button>`}
      </li>`;
    };
    return html`<div class="planner-head">
        <div class="planner-nav">
          <button type="button" class="btn btn-ghost planner-step" data-action="planner-week" data-id="-1" aria-label="Previous week"${ctx.week <= 0 && UI.raw(' disabled')}>‹</button>
          <h3 class="planner-title">${title.name} <span class="planner-span">${title.span}</span></h3>
          <button type="button" class="btn btn-ghost planner-step" data-action="planner-week" data-id="1" aria-label="Next week"${ctx.week >= WEEKS - 1 && UI.raw(' disabled')}>›</button>
        </div>
        ${ctx.canPlan && html`<button type="button" class="btn btn-primary" data-action="plan-add">+ Plan a session</button>`}
      </div>
      ${notice(ctx)}
      <ol class="planner-week" aria-label="${title.name}, ${title.span}">${days.map(day)}</ol>`;
  }

  return { ROTATION, OPEN_MS, WEEKS, dayKey, fromKey, addDays, fridayFocus, nextFriday,
    weekStart, defaultWeek, clampWeek, range, weekOf, isOpen, joiners, arrivals, arrivalOf, timeLabel, nextPlan, activityEmoji,
    suggestions, readPlan, readArrival, formatDay, formatTime, timeValue, lastDay, fridayNote, fridayBoard, otherCallout, tvNote,
    week, session };
})();
