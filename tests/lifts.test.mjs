import test from 'node:test';
import assert from 'node:assert/strict';
import { environment, athlete } from './helpers.mjs';
const { Lifts, parseLiftTime, formatLiftTime, HistoryView } = environment();

test('time parsing rejects ambiguous or malformed records', () => {
  for (const bad of ['6:99', '6:3', '6:30oops', '12abc', '-5', 'Infinity', '1.2', '1:30.5']) {
    assert.ok(Number.isNaN(parseLiftTime(bad)), bad);
  }
  for (const [input, seconds] of [['6:30', 390], ['390', 390], [' 0:08 ', 8], ['', 0], ['00:00', 0]]) {
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
test('history escapes unknown labels and ignores invalid points', () => {
  const html = HistoryView.render([
    {payload:{lift:'<img src=x onerror=alert(1)>',value:10},decided_at:'2026-01-01'},
    {payload:{lift:'bench',value:'broken'},decided_at:'2026-01-02'},
  ]);
  assert.ok(html.includes('&lt;img'));
  assert.ok(!html.includes('<img'));
  assert.ok(!html.includes('NaN'));
});
test('history plots elapsed time, including repeated timestamps', () => {
  const series = [{value:10,at:'2026-01-01'}, {value:15,at:'2026-01-02'}, {value:20,at:'2026-01-11'}];
  assert.match(HistoryView.sparkline('bench', series), /cx="41.6"/);
  assert.ok(!HistoryView.sparkline('bench', series.map((p) => ({...p,at:'2026-01-01'}))).includes('NaN'));
});
