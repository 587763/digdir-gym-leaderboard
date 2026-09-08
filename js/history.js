// Pure progression rendering. Approved proposals remain the source of history.
window.HistoryView = new class {
  escapeHtml(text) { return escapeAttr(text); }
  liftUnit(id) { return window.Lifts.unit(id); }
  displayValueUnit(id, value) { return window.Lifts.formatUnit(id, value); }
  render(rows) {
    const byLift = new Map();
    for (const r of rows) {
      const lift = r.payload?.lift;
      if (!lift || !Number.isFinite(Number(r.payload.value)) || !Number.isFinite(Date.parse(r.decided_at))) continue;
      if (!byLift.has(lift)) byLift.set(lift, []);
      byLift.get(lift).push({ value: Number(r.payload.value), at: r.decided_at });
    }
    if (byLift.size === 0) {
      return '<p class="empty-state">The story starts with your first verified PR.<br>Records added directly by an admin are not part of this history.</p>';
    }
    // Main lifts first, then "other lifts", in their registry order; unknowns last.
    const order = [...window.Lifts.main, ...window.OTHER_LIFTS.map((l) => l.id)];
    const liftIds = [...byLift.keys()].sort((x, y) => {
      const ix = order.indexOf(x), iy = order.indexOf(y);
      return (ix < 0 ? 99 : ix) - (iy < 0 ? 99 : iy);
    });
    return liftIds.map((lid) => this.renderHistoryLift(lid, byLift.get(lid).sort((a, b) => Date.parse(a.at) - Date.parse(b.at)))).join('');
  }

  renderHistoryLift(lid, series) {
    const meta = window.Lifts.meta[lid] || window.getOtherLift(lid) || { emoji: '', label: lid };
    const first = series[0].value;
    const last = series[series.length - 1].value;
    const delta = last - first;
    // For lowerIsBetter lifts (e.g. a run) a smaller value is the improvement.
    const improved = window.getOtherLift(lid)?.lowerIsBetter ? delta <= 0 : delta >= 0;
    const head = series.length === 1
      ? '<span class="history-delta first">first PR</span>'
      : `<span class="history-delta ${improved ? 'up' : 'down'}">${this.displaySignedDelta(lid, delta)}</span>`;
    const points = series.map((p) =>
      `<li><span class="hist-date">${this.formatDate(p.at)}</span><span class="hist-val">${this.escapeHtml(this.displayValueUnit(lid, p.value))}</span></li>`
    ).join('');
    return `<div class="history-lift">
      <div class="history-lift-head">
        <h3>${meta.emoji} ${this.escapeHtml(meta.label)}</h3>
        ${head}
      </div>
      ${this.sparkline(lid, series)}
      <ul class="history-points">${points}</ul>
    </div>`;
  }

  // Hand-rolled inline SVG line chart. Uniform scaling (no preserveAspectRatio
  // tricks) so dots stay round; #squiggle gives it the whiteboard look.
  sparkline(lid, series) {
    const W = 320, H = 90, pad = 12;
    const vals = series.map((s) => s.value);
    const min = Math.min(...vals), max = Math.max(...vals);
    const n = series.length;
    const dates = series.map((point) => Date.parse(point.at));
    const elapsed = dates[n - 1] - dates[0];
    const x = (i) => n === 1 ? W / 2 : pad + (elapsed > 0 ? (dates[i] - dates[0]) / elapsed : i / (n - 1)) * (W - 2 * pad);
    const y = (v) => max === min ? H / 2 : H - pad - ((v - min) / (max - min)) * (H - 2 * pad);
    const dot = (s, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(s.value).toFixed(1)}" r="4"><title>${this.escapeHtml(this.formatDate(s.at) + ': ' + this.displayValueUnit(lid, s.value))}</title></circle>`;
    const dots = series.map(dot).join('');
    const line = n > 1
      ? `<polyline class="spark-line" points="${series.map((s, i) => `${x(i).toFixed(1)},${y(s.value).toFixed(1)}`).join(' ')}" filter="url(#squiggle)"/>`
      : '';
    return `<svg class="sparkline" viewBox="0 0 ${W} ${H}" role="img" aria-label="Progression chart">${line}${dots}</svg>`;
  }

  // Signed change for the lift's unit ("+12.5 kg" / "−0:08" for time lifts).
  displaySignedDelta(lid, delta) {
    const sign = delta > 0 ? '+' : delta < 0 ? '−' : '';
    const unit = this.liftUnit(lid);
    const mag = Math.abs(delta);
    if (unit === 'time') return `${sign}${window.formatLiftTime(mag)}`;
    if (unit === 'reps') return `${sign}${Math.round(mag)} reps`;
    return `${sign}${mag.toFixed(1)} kg`;
  }

  formatDate(iso) {
    if (!iso) return '';
    return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  }

};
