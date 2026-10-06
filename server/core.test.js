import test from 'node:test';
import assert from 'node:assert/strict';
import { schedule, weakFirst } from './srs.js';
import { StudyQueue, grade, levenshtein, parseDelimited, toCSV } from '../public/lib.js';

const DAY = 86_400_000;

test('scheduler: good grows stability, again lapses and shrinks it', () => {
  const t0 = 1_700_000_000_000;
  const first = schedule(null, 3, t0);
  assert.equal(first.stability, 3.2);
  const good = schedule(first, 3, t0 + 3 * DAY);
  assert.ok(good.stability > first.stability * 1.5, `stability should grow, got ${good.stability}`);
  assert.ok(good.next_due > t0 + 3 * DAY + 3 * DAY);
  const again = schedule(good, 1, good.next_due);
  assert.equal(again.lapses, 1);
  assert.ok(again.stability < good.stability);
  assert.equal(again.next_due - good.next_due, 10 * 60_000);
  assert.ok(schedule(first, 4, t0 + 3 * DAY).stability > schedule(first, 2, t0 + 3 * DAY).stability);
});

test('weakFirst: lapses desc, then low stability, new cards last', () => {
  const cards = [{ id: 1, last_reviewed: null }, { id: 2, last_reviewed: 1, lapses: 0, stability: 2 }, { id: 3, last_reviewed: 1, lapses: 3, stability: 9 }, { id: 4, last_reviewed: 1, lapses: 0, stability: 0.5 }];
  assert.deepEqual(cards.sort(weakFirst).map((c) => c.id), [3, 4, 2, 1]);
});

test('queue: missed card returns after 3–5 cards and needs two correct answers', () => {
  const q = new StudyQueue(Array.from({ length: 10 }, (_, i) => ({ id: i })), () => 0); // gap = 3
  q.answer(false); // miss card 0
  assert.deepEqual(q.q.slice(0, 4), [1, 2, 3, 0]);
  q.answer(true); q.answer(true); q.answer(true);
  assert.equal(q.current.id, 0);
  q.answer(true); // first correct -> comes back again
  assert.ok(q.q.includes(0));
  while (q.current.id !== 0) q.answer(true);
  q.answer(true); // second correct -> gone
  assert.ok(!q.q.includes(0));
  while (!q.done) q.answer(true);
  assert.equal(q.miss.get(0), 1);
  assert.equal(q.firstTry.get(0), false);
  assert.equal(q.firstTry.get(1), true);
});

test('queue: undo restores state and returns meta', () => {
  const q = new StudyQueue([{ id: 1 }, { id: 2 }]);
  q.answer(false, 'm1');
  assert.equal(q.undo(), 'm1');
  assert.deepEqual(q.q, [1, 2]);
  assert.equal(q.miss.size, 0);
});

test('grade: fuzzy typos, accents, alternatives', () => {
  assert.equal(levenshtein('kitten', 'sitting'), 3);
  assert.equal(grade('to eat', 'to eat'), 'exact');
  assert.equal(grade('to eta', 'to eat'), 'close');
  assert.equal(grade('ata', 'äta'), 'close');
  assert.equal(grade('dine', 'to eat; dine'), 'exact');
  assert.equal(grade('cat', 'dog'), 'wrong');
  assert.equal(grade('', 'dog'), 'wrong');
  assert.equal(grade('**Paris**', 'Paris'), 'exact');
});

test('import/export: TSV, CSV with quotes, round trip', () => {
  assert.deepEqual(parseDelimited('hund\tdog\nkatt\tcat\n'), [['hund', 'dog'], ['katt', 'cat']]);
  assert.deepEqual(parseDelimited('"a, b","line1\nline2"\nc,d'), [['a, b', 'line1\nline2'], ['c', 'd']]);
  const rows = [['q "x"', 'a,b'], ['multi\nline', 'ok']];
  assert.deepEqual(parseDelimited(toCSV(rows), ','), rows);
});
