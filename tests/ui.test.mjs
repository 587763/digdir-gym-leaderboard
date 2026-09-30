import test from 'node:test';
import assert from 'node:assert/strict';
import { environment, athlete } from './helpers.mjs';

const { UI, BoardView } = environment(['ui', 'achievements', 'lifts', 'avatar', 'history', 'board']);
const { html, raw } = UI;
const EVIL = '<img src=x onerror=alert(1)>"\'&';
const ctx = (athletes, extra = {}) => ({ athletes, pending: new Set(), fresh: new Map(), latest: [], ...extra });

test('html templates escape every interpolation unless it is already safe markup', () => {
  assert.equal(String(html`<b title="${EVIL}">${EVIL}</b>`),
    '<b title="&lt;img src=x onerror=alert(1)&gt;&quot;&#39;&amp;">&lt;img src=x onerror=alert(1)&gt;&quot;&#39;&amp;</b>');
  assert.equal(String(html`<ul>${['a', html`<li>${'<b>'}</li>`]}</ul>`), '<ul>a<li>&lt;b&gt;</li></ul>');
  assert.equal(String(html`${null}${undefined}${false}${0}${raw('<hr>')}`), '0<hr>');
});

test('every board view escapes athlete names', () => {
  const a = athlete('x', { name: EVIL, bench: 100, achievements: ['gripper90kg'], lifts: { run1k: 300 } });
  const views = [
    BoardView.section('bench', ctx([a])),                                          // podium
    BoardView.section('bench', ctx([a], { podiumFits: false })),                   // table row
    BoardView.hallOfFame(ctx([a])), BoardView.hallOfFame(ctx([a], { hallTable: true })),
    BoardView.latest(ctx([a], { latest: [{ id: 'p', athlete: a, lift: 'run1k', value: 300, previous: 320, at: '2026-01-01' }] })),
  ].map(String);
  for (const view of views) {
    assert.ok(!view.includes('<img'), view);
    assert.ok(view.includes('&lt;img'));
  }
});

test('podium and table rows both show pending and fresh markers, and highlight the member', () => {
  const athletes = [1, 2, 3, 4].map((i) => athlete(`a${i}`, { bench: 100 - i }));
  const marks = { pending: new Set(['a1', 'a4']), fresh: new Map([['a1:bench', new Date().toISOString()]]), me: 'a4' };
  const podium = String(BoardView.section('bench', ctx(athletes, marks)));
  const [top, table] = podium.split('<table');
  assert.match(top, /data-id="a1"[^]*pending[^]*fresh/);
  assert.match(table, /class="is-me"[^]*data-id="a4"[^]*pending/);
});

test('latest feed renders improvements with their gain and an empty state', () => {
  const a = athlete('Ada', { bench: 110 });
  const feed = String(BoardView.latest(ctx([a], { latest: [{ id: 'p', athlete: a, lift: 'bench', value: 110, previous: 100, at: new Date().toISOString() }] })));
  assert.match(feed, /110\.0 kg/);
  assert.match(feed, /\+10\.0 kg/);
  assert.match(String(BoardView.latest(ctx([]))), /No verified PRs yet/);
});

test('relative times read naturally', () => {
  const now = Date.parse('2026-09-30T12:00:00Z');
  assert.equal(UI.timeAgo('2026-09-30T11:59:30Z', now), 'just now');
  assert.equal(UI.timeAgo('2026-09-29T12:00:00Z', now), 'yesterday');
  assert.equal(UI.timeAgo('2026-09-27T12:00:00Z', now), '3 days ago');
  assert.equal(UI.timeAgo('not a date', now), '');
});

test('the latest feed reports a failed load instead of an empty board', () => {
  assert.match(String(BoardView.latest(ctx([], { error: true }))), /unavailable/);
  assert.match(String(BoardView.latest(ctx([], { loading: true }))), /Loading/);
});
