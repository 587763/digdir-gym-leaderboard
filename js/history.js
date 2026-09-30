// Pure progression rendering. Approved PR proposals are the source of history.
window.HistoryView = (() => {
  const { html } = UI;

  const { formatDate } = UI;

  // Hand-rolled inline SVG line chart. Uniform scaling (no preserveAspectRatio
  // tricks) so dots stay round; #squiggle gives it the whiteboard look. Better is
  // always up: faster times plot higher for lowerIsBetter exercises.
  function sparkline(lid, series) {
    const W = 320, H = 90, pad = 12;
    const vals = series.map((s) => s.value);
    const min = Math.min(...vals), max = Math.max(...vals);
    const n = series.length;
    const dates = series.map((point) => Date.parse(point.at));
    const elapsed = dates[n - 1] - dates[0];
    const x = (i) => n === 1 ? W / 2 : pad + (elapsed > 0 ? (dates[i] - dates[0]) / elapsed : i / (n - 1)) * (W - 2 * pad);
    const flip = Lifts.get(lid)?.lowerIsBetter;
    const y = (v) => max === min ? H / 2 : H - pad - (flip ? (max - v) : (v - min)) / (max - min) * (H - 2 * pad);
    const dots = series.map((s, i) => html`<circle cx="${x(i).toFixed(1)}" cy="${y(s.value).toFixed(1)}" r="4"><title>${formatDate(s.at)}: ${Lifts.formatUnit(lid, s.value)}</title></circle>`);
    const line = n > 1 && html`<polyline class="spark-line" points="${series.map((s, i) => `${x(i).toFixed(1)},${y(s.value).toFixed(1)}`).join(' ')}" filter="url(#squiggle)"/>`;
    return html`<svg class="sparkline" viewBox="0 0 ${W} ${H}" role="img" aria-label="Progression chart">${line}${dots}</svg>`;
  }

  // points: every verified value, oldest first. A verified 0 clears the entry: it is
  // noted, but not plotted or compared as a result.
  function lift(lid, points, current) {
    const meta = Lifts.get(lid) || { emoji: '', label: lid };
    const series = points.filter((p) => p.value > 0);
    const latest = points[points.length - 1];
    let head = '';
    if (series.length === 1) head = html`<span class="history-delta first">first PR</span>`;
    else if (series.length > 1) {
      const delta = series[series.length - 1].value - series[0].value;
      const improved = Lifts.get(lid)?.lowerIsBetter ? delta <= 0 : delta >= 0;
      head = html`<span class="history-delta ${improved ? 'up' : 'down'}">${Lifts.formatDelta(lid, delta)}</span>`;
    }
    // Admin corrections change the board without adding a verified point; say so.
    const note = current != null && Number(current) !== latest.value
      ? html`<p class="history-note">On the board now: ${Number(current) > 0 ? Lifts.formatUnit(lid, current) : 'no entry'} (set by an admin)</p>`
      : latest.value === 0 && html`<p class="history-note">Entry cleared on ${formatDate(latest.at)}.</p>`;
    return html`<div class="history-lift">
      <div class="history-lift-head">
        <h3><span aria-hidden="true">${meta.emoji}</span> ${meta.label}</h3>
        ${head}
      </div>
      ${series.length > 0 && html`${sparkline(lid, series)}
      <ul class="history-points">${series.map((p) => html`<li><span class="hist-date">${formatDate(p.at)}</span><span class="hist-val">${Lifts.formatUnit(lid, p.value)}</span></li>`)}</ul>`}
      ${note}
    </div>`;
  }

  // rows: approved PR proposals; athlete (optional): the current record for comparison.
  function render(rows, athlete = null) {
    const byLift = new Map();
    for (const r of rows) {
      const lid = r.payload?.lift;
      if (!lid || !Number.isFinite(Number(r.payload.value)) || !Number.isFinite(Date.parse(r.decided_at))) continue;
      if (!byLift.has(lid)) byLift.set(lid, []);
      byLift.get(lid).push({ value: Number(r.payload.value), at: r.decided_at });
    }
    if (byLift.size === 0) {
      return html`<p class="empty-state">The story starts with your first verified PR.<br>Records added directly by an admin are not part of this history.</p>`;
    }
    // Registry order first; unknown (retired) exercises last.
    const order = Lifts.all.map((e) => e.id);
    const rank = (id) => { const i = order.indexOf(id); return i < 0 ? order.length : i; };
    return html`${[...byLift.keys()].sort((a, b) => rank(a) - rank(b)).map((lid) => {
      const points = byLift.get(lid).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
      const current = athlete && Lifts.get(lid) ? Lifts.value(athlete, lid) : null;
      return lift(lid, points, current);
    })}`;
  }

  return { render, sparkline };
})();
