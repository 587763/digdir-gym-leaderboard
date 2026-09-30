import test from 'node:test';
import assert from 'node:assert/strict';
import { environment, athlete } from './helpers.mjs';
const { Lifts, HistoryView } = environment();
const { parseTime: parseLiftTime, formatTime: formatLiftTime } = Lifts;

test('time parsing rejects ambiguous or malformed records', () => {
  for (const bad of ['6:99', '6:3', '6:30oops', '12abc', '-5', 'Infinity', '1.2', '1:30.5', '6.99', '1,5']) {
    assert.ok(Number.isNaN(parseLiftTime(bad)), bad);
  }
  for (const [input, seconds] of [['6:30', 390], ['6.30', 390], ['6,30', 390], ['390', 390], [' 0:08 ', 8], ['', 0], ['00:00', 0]]) {
    assert.equal(parseLiftTime(input), seconds);
    assert.equal(parseLiftTime(formatLiftTime(seconds)), seconds);
  }
});
test('input limits match storage precision and exercise units', () => {
  assert.equal(Lifts.parse('bench', '132.5'), 132.5);
  assert.equal(Lifts.parse('bench', '132.1'), 132.1);
  for (const [id, value] of [['bench','132.55'], ['bench','Infinity'], ['bench','-1'], ['pullups','4.5'], ['run1k','100000']]) {
    assert.ok(Number.isNaN(Lifts.parse(id, value)));
  }
});
test('competition ranks preserve ties, skip empty scores and order tied names', () => {
  const rows = Lifts.ranked([athlete('Z', {bench: 100}), athlete('A', {bench: 100}), athlete('C', {bench: 90}), athlete('Empty')], 'bench');
  assert.deepEqual(Array.from(rows, (r) => [r.athlete.name, r.rank]), [['A',1],['Z',1],['C',3]]);
});
test('cardio ranks fastest first without rewarding missing times', () => {
  const rows = Lifts.ranked([athlete('Slow', {lifts:{run1k:400}}), athlete('None'), athlete('Fast', {lifts:{run1k:300}})], 'run1k');
  assert.deepEqual(Array.from(rows, (r) => r.athlete.name), ['Fast','Slow']);
});
test('total adds numeric strings and excludes athletes without any records', () => {
  assert.equal(Lifts.value(athlete('A',{bench:'100',squat:'120',deadlift:'150'}), 'total'), 370);
  assert.equal(Lifts.ranked([athlete('Empty')], 'total').length, 0);
});
test('equal decimal totals share a rank despite different floating-point sums', () => {
  const rows = Lifts.ranked([
    athlete('A', {squat:100.1, bench:100.2, deadlift:100.3}),
    athlete('B', {squat:'100.2', bench:'100.3', deadlift:'100.1'}),
    athlete('C', {squat:100, bench:100, deadlift:100}),
  ], 'total');
  assert.deepEqual(Array.from(rows, (r) => [r.athlete.name, r.value, r.rank]),
    [['A',300.6,1],['B',300.6,1],['C',300,3]]);
});
test('history escapes unknown labels and ignores invalid points', () => {
  const html = String(HistoryView.render([
    {payload:{lift:'<img src=x onerror=alert(1)>',value:10},decided_at:'2026-01-01'},
    {payload:{lift:'bench',value:'broken'},decided_at:'2026-01-02'},
  ]));
  assert.ok(html.includes('&lt;img'));
  assert.ok(!html.includes('<img'));
  assert.ok(!html.includes('NaN'));
});
test('history plots elapsed time, including repeated timestamps', () => {
  const series = [{value:10,at:'2026-01-01'}, {value:15,at:'2026-01-02'}, {value:20,at:'2026-01-11'}];
  assert.match(String(HistoryView.sparkline('bench', series)), /cx="41.6"/);
  assert.ok(!String(HistoryView.sparkline('bench', series.map((p) => ({...p,at:'2026-01-01'})))).includes('NaN'));
});
test('history notes cleared entries instead of plotting them as results', () => {
  const html = String(HistoryView.render([
    {payload:{lift:'run1k',value:390},decided_at:'2026-01-01'},
    {payload:{lift:'run1k',value:0},decided_at:'2026-02-01'},
  ]));
  assert.match(html, /first PR/);
  assert.match(html, /Entry cleared on/);
  assert.ok(!html.includes('0:00'));
});
test('history charts put the better result higher, including faster times', () => {
  const ys = (lift, values) => [...String(HistoryView.sparkline(lift, values.map((value, i) => ({value, at:`2026-0${i + 1}-01`})))).matchAll(/cy="([\d.]+)"/g)].map((m) => Number(m[1]));
  const [slow, fast] = ys('run1k', [400, 300]);
  assert.ok(fast < slow, 'a faster time is plotted higher');
  const [light, heavy] = ys('bench', [100, 120]);
  assert.ok(heavy < light);
});
test('history explains when the board differs from the last verified value', () => {
  const html = String(HistoryView.render([{payload:{lift:'bench',value:100},decided_at:'2026-01-01'}], athlete('A',{bench:105})));
  assert.match(html, /On the board now: 105\.0 kg \(set by an admin\)/);
});
test('improvements respect the direction of each exercise', () => {
  assert.equal(Lifts.improves('bench', 100, 110), true);
  assert.equal(Lifts.improves('bench', 110, 100), false);
  assert.equal(Lifts.improves('run1k', 300, 290), true);
  assert.equal(Lifts.improves('run1k', 0, 290), true);
  assert.equal(Lifts.improves('run1k', 300, 0), false);
  assert.equal(Lifts.formatDelta('run1k', -8), '−0:08');
});
