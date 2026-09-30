// Pure board rendering: leaderboard sections, podiums, medals, the Hall of Fame and
// the latest verified PRs. Every function returns UI.html markup from plain data;
// app.js owns the DOM.
//
// Render context (ctx): { athletes, tv, loading, error, viewportHeight,
//   pending: Set<athleteId>   athletes with a pending change (⏳)
//   fresh: Map<"athleteId:liftId", decidedAt>  PRs verified recently (🔥)
//   me: athleteId | null      the signed-in member's athlete, highlighted
//   podiumFits: boolean       TV fitting may withdraw a podium
//   hallTable: boolean        TV fitting may switch the Hall of Fame to paged tables
//   latest: [{ id, athlete, lift, value, previous, at }]  newest first }
window.BoardView = (() => {
  const { html, raw } = UI;
  const MEDALS = { 1: '🥇', 2: '🥈', 3: '🥉' };
  const MEDAL_COLORS = { 1: ['var(--gold)', '#d99e16'], 2: ['var(--silver)', '#94a3b8'], 3: ['var(--bronze)', '#b06a44'] };
  // More medalists than this (big ties) use the complete ranked table instead.
  const MAX_PODIUM_ATHLETES = 6;
  // Below this TV viewport height there is no room for podiums plus ranked rows.
  const TV_MIN_PODIUM_HEIGHT = 760;
  // Names per row when a crowded TV Hall of Fame falls back to paged tables.
  const HALL_COLUMNS = 3;
  const icon = (emoji) => html`<span aria-hidden="true">${emoji}</span>`;
  const avatar = (athlete, size) => raw(window.renderAvatar(athlete, size, { decorative: true }));

  const title = (lift) => lift.id === 'total' ? html`${icon(lift.emoji)} Total (Combined)` : html`${icon(lift.emoji)} ${lift.label}`;
  const scoreHeading = (lift) => lift.id === 'total' ? 'Total (kg)'
    : lift.unit === 'time' ? 'Time' : lift.unit === 'reps' ? 'Reps' : 'PR (kg)';

  const badges = (athlete) => (athlete.achievements || []).map((id) => window.getAchievement(id)).filter(Boolean)
    .map((a) => html`<span class="badge-chip" title="${a.name}">${a.emoji}</span>`);

  // Status chips after a name: a pending change, or a PR verified in the last week.
  function chips(athlete, liftId, ctx) {
    const freshAt = ctx.fresh?.get(`${athlete.id}:${liftId}`);
    return html`${ctx.pending?.has(athlete.id) && raw('<span class="badge-chip pending" title="Has a pending change">⏳</span>')}${
      freshAt && html`<span class="badge-chip fresh" title="New PR, verified ${UI.timeAgo(freshAt)}">🔥</span>`}`;
  }

  // Inline SVG medal (gold/silver/bronze + rank), symmetric about the viewBox center
  // so it sits dead-centered under the figure. Emoji medals paint off-center on many
  // platforms, and this matches the marker look better.
  function medal(rank, size = 32) {
    const [fill, edge] = MEDAL_COLORS[rank] || MEDAL_COLORS[1];
    return html`<svg class="medal-svg" viewBox="0 0 40 50" width="${size}" height="${size * 1.25}"
         role="img" aria-label="rank ${rank}" xmlns="http://www.w3.org/2000/svg">
      <path d="M13 3 L21 27 L11 29 Z" fill="#8aa0c4"/>
      <path d="M27 3 L19 27 L29 29 Z" fill="#d09a9a"/>
      <circle cx="20" cy="34" r="14" fill="${fill}" stroke="${edge}" stroke-width="2.5"/>
      <text x="20" y="39.5" text-anchor="middle" font-size="15" font-weight="700" fill="#5a4636"
            font-family="'Permanent Marker','Caveat',cursive">${rank}</text>
    </svg>`;
  }

  const historyLink = (athlete, cls = 'athlete-link') =>
    html`<button type="button" class="${cls}" data-action="history" data-id="${athlete.id}" title="See progression">${athlete.name}</button>`;

  function podium(winners, lift, ctx) {
    const spots = [2, 1, 3].map((rank) => {
      const athletes = winners.filter((row) => row.rank === rank);
      if (!athletes.length) return '';
      const size = athletes.length > 1 ? 36 : ctx.tv ? 48 : 64;
      const mine = athletes.some(({ athlete }) => athlete.id === ctx.me);
      return html`<div class="podium-spot ${['', 'first', 'second', 'third'][rank]}${mine && ' is-me'}">
        <div class="podium-athlete">
          <div class="podium-avatars">${athletes.map(({ athlete }) => avatar(athlete, size))}</div>
          <div class="podium-medal">${medal(rank, ctx.tv ? 26 : 28)}</div>
          <div class="podium-name">${athletes.map(({ athlete }, i) => html`${i > 0 && raw('<span class="tie-join"> &amp; </span>')}${historyLink(athlete)}${chips(athlete, lift.id, ctx)}`)}</div>
          <div class="podium-value">${Lifts.formatUnit(lift.id, athletes[0].value)}</div>
        </div><div class="podium-stand"><div class="podium-rank">${rank}</div></div>
      </div>`;
    });
    return html`<div class="podium-container">${spots}</div>`;
  }

  function emptyRow(ctx, columns = 3, empty = html`A record waiting to happen.<br><span>Be the first on this board.</span>`) {
    const message = ctx.loading ? html`Loading the board…`
      : ctx.error ? html`The board is unavailable. Try again above.` : empty;
    return html`<tr class="empty-row"><td colspan="${columns}" class="empty-state">${message}</td></tr>`;
  }

  const row = ({ athlete, rank }, lift, ctx) => html`<tr${athlete.id === ctx.me && raw(' class="is-me"')}>
        <td><span class="rank">${MEDALS[rank] || rank}</span></td>
        <td>${historyLink(athlete, 'athlete-name athlete-link')}${badges(athlete)}${chips(athlete, lift.id, ctx)}</td>
        <td><span class="pr-value">${Lifts.format(lift.id, Lifts.value(athlete, lift.id))}</span></td>
      </tr>`;

  // Whether a board shows its podium: small medal groups, and on TV only when the
  // viewport is tall enough and fitting hasn't withdrawn it.
  function showsPodium(winners, ctx) {
    return ctx.podiumFits !== false && winners.length <= MAX_PODIUM_ATHLETES
      && (!ctx.tv || (ctx.viewportHeight ?? Infinity) >= TV_MIN_PODIUM_HEIGHT);
  }

  // One exercise board (or the combined total): heading, optional podium, ranked table.
  function section(liftId, ctx) {
    const lift = Lifts.get(liftId);
    const ranked = Lifts.ranked(ctx.athletes, liftId);
    const winners = ranked.filter((r) => r.rank <= 3);
    const withPodium = ranked.length > 0 && showsPodium(winners, ctx);
    const tableRows = withPodium ? ranked.filter((r) => r.rank > 3) : ranked;
    const body = ranked.length === 0 ? emptyRow(ctx) : tableRows.map((r) => row(r, lift, ctx));
    return html`<div class="leaderboard-section${liftId === 'total' ? ' leaderboard-total' : ''}" data-lift="${liftId}">
          <h2>${title(lift)}</h2>${withPodium && podium(winners, lift, ctx)}
          <table class="leaderboard-table" id="${liftId}Table"${ranked.length > 0 && tableRows.length === 0 && raw(' hidden')}><thead><tr><th scope="col">Rank</th><th scope="col">Name</th><th scope="col">${scoreHeading(lift)}</th></tr></thead><tbody>${body}</tbody></table>
        </div>`;
  }

  // Latest verified improvements, newest first, as one paged-friendly table.
  function latest(ctx) {
    const items = ctx.latest || [];
    const body = items.length === 0
      ? emptyRow(ctx, 2, html`No verified PRs yet.<br><span>Submit one from My PRs and ask a gym buddy to verify it.</span>`)
      : items.map((item) => {
        const lift = Lifts.get(item.lift);
        const delta = item.previous > 0 && html` <span class="delta up">${Lifts.formatDelta(item.lift, item.value - item.previous)}</span>`;
        return html`<tr${item.athlete.id === ctx.me && raw(' class="is-me"')}>
          <td><div class="latest-who">${avatar(item.athlete, ctx.tv ? 30 : 34)}<span>${historyLink(item.athlete, 'athlete-name athlete-link')}<span class="latest-lift">${icon(lift.emoji)} ${lift.label} · <span class="latest-when">${UI.timeAgo(item.at)}</span></span></span></div></td>
          <td><span class="pr-value">${Lifts.formatUnit(item.lift, item.value)}</span>${delta}</td>
        </tr>`;
      });
    return html`<div class="leaderboard-section latest-board" data-feed="latest">
      <h2>${icon('🔥')} Latest verified PRs</h2>
      <table class="leaderboard-table latest-table"><thead><tr><th scope="col">Who</th><th scope="col">PR</th></tr></thead><tbody>${body}</tbody></table>
    </div>`;
  }

  // All boards of a tab group ('main', 'total', 'other', 'cardio', 'latest').
  function group(name, ctx) {
    if (name === 'latest') return latest(ctx);
    const ids = name === 'total' ? ['total'] : Lifts.inGroup(name).map((e) => e.id);
    return ids.length ? html`${ids.map((id) => section(id, ctx))}` : html`<p class="empty-state">Nothing here yet.</p>`;
  }

  // Badge cards everywhere; on TV, paged tables when the cards don't fit the screen.
  function hallOfFame(ctx) {
    return html`${window.ACHIEVEMENTS.map((ach) => {
      const achievers = ctx.athletes.filter((a) => (a.achievements || []).includes(ach.id))
        .sort((a, b) => a.name.localeCompare(b.name));
      const body = achievers.length === 0
        ? html`<div class="empty-achievement"><p>${ach.emptyText}</p></div>`
        : ctx.hallTable
          ? html`<table class="leaderboard-table hall-table"><thead><tr><th scope="col" colspan="${HALL_COLUMNS}">${ach.title}</th></tr></thead><tbody>${
            Array.from({ length: Math.ceil(achievers.length / HALL_COLUMNS) }, (_, r) => html`<tr>${
              achievers.slice(r * HALL_COLUMNS, (r + 1) * HALL_COLUMNS).map((a) => html`<td>${historyLink(a, 'athlete-name athlete-link')}</td>`)}</tr>`)}</tbody></table>`
          : html`<div class="hall-of-fame">${achievers.map((a) => html`<div class="achievement-badge${a.id === ctx.me && ' is-me'}"><div class="badge-avatar">${avatar(a, ctx.tv ? 58 : 66)}</div>${historyLink(a, 'badge-name athlete-link')}<div class="badge-subtitle">${ach.title}</div></div>`)}</div>
           <div class="achievement-count">${achievers.length} ${achievers.length === 1 ? 'person has' : 'people have'} earned this</div>`;
      return html`<div class="achievement-section${ctx.hallTable && ' leaderboard-section'}"><h2>${icon(ach.emoji)} ${ach.name}</h2><p class="achievement-description">${ach.description}</p>${body}</div>`;
    })}`;
  }

  return { section, group, latest, podium, medal, badges, hallOfFame, MAX_PODIUM_ATHLETES };
})();
