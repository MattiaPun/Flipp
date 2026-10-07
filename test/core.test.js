// Unit tests for pure logic: scheduler, study queue, grading, cloze, diff, CSV, TOTP, tar archives, optimizer, file sniffing.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { schedule, weakFirst, preview, formatInterval, STATE, DEFAULT_W, model } from '../public/srs.js';
import { StudyQueue, grade, levenshtein, parseDelimited, toCSV, clozeNumbers, renderCloze, sides, charDiff } from '../public/lib.js';

const DAY = 86_400_000, MIN = 60_000;
process.env.DATA_DIR ||= fs.mkdtempSync(path.join(os.tmpdir(), 'flipp-unit-')); // storage.js opens the DB

test('scheduler: new card walks learning steps, graduates, grows on Good, relearns on Again', () => {
  const t0 = 1_700_000_000_000;
  const a = schedule(null, 3, t0);
  assert.equal(a.state, STATE.LEARNING);
  assert.equal(a.next_due - t0, 10 * MIN); // second step
  const b = schedule(a, 3, a.next_due);
  assert.equal(b.state, STATE.REVIEW);
  assert.ok(b.next_due - b.last_reviewed >= DAY);
  const c = schedule(b, 3, b.next_due);
  assert.ok(c.stability > b.stability * 1.5, `stability should grow, got ${b.stability} -> ${c.stability}`);
  const lapse = schedule(c, 1, c.next_due);
  assert.equal(lapse.state, STATE.RELEARNING);
  assert.equal(lapse.lapses, 1);
  assert.ok(lapse.lapsed);
  assert.ok(lapse.stability < c.stability);
  assert.equal(lapse.next_due - lapse.last_reviewed, 10 * MIN);
  const back = schedule(lapse, 3, lapse.next_due);
  assert.equal(back.state, STATE.REVIEW);
});

test('scheduler: Easy skips learning; ratings order intervals; higher retention -> shorter intervals', () => {
  const t0 = 1_700_000_000_000;
  assert.equal(schedule(null, 4, t0).state, STATE.REVIEW);
  const card = schedule(schedule(null, 4, t0), 3, t0 + 8 * DAY);
  const ivl = (g) => schedule(card, g, card.next_due).next_due - card.next_due;
  assert.ok(ivl(1) < ivl(2) && ivl(2) < ivl(3) && ivl(3) < ivl(4), 'Again < Hard < Good < Easy');
  const at = (retention) => schedule(card, 3, card.next_due, { config: { retention } }).next_due;
  assert.ok(at(0.95) < at(0.85));
  assert.deepEqual(preview(null, t0), ['1m', '6m', '10m', formatInterval(schedule(null, 4, t0).next_due - t0)]);
  assert.equal(schedule(null, 3, t0, { config: { steps: [] } }).state, STATE.REVIEW);
});

test('scheduler: FSRS-6 retrievability is 90% after `stability` days', () => {
  const m = model(DEFAULT_W);
  assert.ok(Math.abs(m.retrievability(10, 10) - 0.9) < 1e-9);
  assert.ok(Math.abs(m.intervalDays(10, 0.9) - 10) < 1e-6);
});

test('weakFirst: lapses desc, then low stability, new cards last', () => {
  const cards = [{ id: 1, last_reviewed: null }, { id: 2, last_reviewed: 1, lapses: 0, stability: 2 }, { id: 3, last_reviewed: 1, lapses: 3, stability: 9 }, { id: 4, last_reviewed: 1, lapses: 0, stability: 0.5 }];
  assert.deepEqual(cards.sort(weakFirst).map((c) => c.id), [3, 4, 2, 1]);
});

test('queue: missed card returns after 3–5 cards and needs two correct answers', () => {
  const q = new StudyQueue(Array.from({ length: 10 }, (_, i) => ({ id: i })), () => 0); // gap = 3
  q.answer(false);
  assert.deepEqual(q.q.slice(0, 4), [1, 2, 3, 0]);
  q.answer(true); q.answer(true); q.answer(true);
  assert.equal(q.current.id, 0);
  q.answer(true);
  assert.ok(q.q.includes(0));
  while (q.current.id !== 0) q.answer(true);
  q.answer(true);
  assert.ok(!q.q.includes(0));
  while (!q.done) q.answer(true);
  assert.equal(q.miss.get(0), 1);
  assert.equal(q.firstTry.get(0), false);
  assert.equal(q.firstTry.get(1), true);
});

test('queue: keyed items (card + variant) and undo', () => {
  const q = new StudyQueue([{ id: 7, key: '7:0' }, { id: 7, key: '7:1' }]);
  assert.equal(q.total, 2);
  q.answer(false, 'm1');
  assert.equal(q.undo(), 'm1');
  assert.deepEqual(q.q, ['7:0', '7:1']);
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

test('cloze: numbers, rendering per variant, sides()', () => {
  const text = '{{c1::Stockholm}} is the capital of {{c2::Sweden::country}}. {{c1::It}} is big.';
  assert.deepEqual(clozeNumbers(text), [1, 2]);
  assert.equal(renderCloze(text, 2, false), 'Stockholm is the capital of **[country]**. It is big.');
  assert.equal(renderCloze(text, 1, true), '**Stockholm** is the capital of Sweden. **It** is big.');
  const s = sides({ type: 'cloze', front: text, back: 'extra' }, 1);
  assert.equal(s.expected, 'Stockholm, It');
  assert.deepEqual(sides({ type: 'basic', front: 'a', back: 'b' }, 1), { prompt: 'b', answer: 'a', expected: 'a', extra: '' });
});

test('charDiff marks wrong and missing characters', () => {
  const out = charDiff('helo', 'hello').map((d) => (d.op === 'ok' ? d.ch : `[${d.op}:${d.ch}]`)).join('');
  assert.equal(out, 'he[missing:l]lo');
});

test('import/export: TSV, CSV with quotes, round trip', () => {
  assert.deepEqual(parseDelimited('hund\tdog\nkatt\tcat\n'), [['hund', 'dog'], ['katt', 'cat']]);
  assert.deepEqual(parseDelimited('"a, b","line1\nline2"\nc,d'), [['a, b', 'line1\nline2'], ['c', 'd']]);
  const rows = [['q "x"', 'a,b'], ['multi\nline', 'ok']];
  assert.deepEqual(parseDelimited(toCSV(rows), ','), rows);
});

test('TOTP matches RFC 6238 vectors and rejects replays', async () => {
  const { base32Encode, base32Decode, hotp, verifyTotp } = await import('../server/totp.js');
  const secret = base32Encode(Buffer.from('12345678901234567890'));
  assert.equal(base32Decode(secret).toString(), '12345678901234567890');
  assert.equal(hotp(secret, Math.floor(59 / 30)), '287082');
  assert.equal(hotp(secret, Math.floor(1111111109 / 30)), '081804');
  const now = 1111111109 * 1000;
  const step = verifyTotp(secret, '081804', { now });
  assert.equal(step, Math.floor(1111111109 / 30));
  assert.equal(verifyTotp(secret, '081804', { now, lastStep: step }), null);
  assert.equal(verifyTotp(secret, '000000', { now }), null);
});

test('tar.gz writer/reader round trip', async () => {
  const { tarGzWriter, readTarGz } = await import('../server/archive.js');
  const file = path.join(os.tmpdir(), `flipp-test-${process.pid}.tar.gz`);
  const w = tarGzWriter(fs.createWriteStream(file));
  await w.addBuffer('a.json', Buffer.from('{"x":1}'));
  await w.addBuffer('dir/b.bin', Buffer.alloc(1000, 7));
  await w.addBuffer('empty', Buffer.alloc(0));
  await w.finish();
  const got = [];
  for await (const e of readTarGz(fs.createReadStream(file))) got.push([e.name, e.data.length]);
  fs.rmSync(file);
  assert.deepEqual(got, [['a.json', 7], ['dir/b.bin', 1000], ['empty', 0]]);
});

test('file sniffing allows images/audio, rejects SVG/HTML', async () => {
  const { sniff } = await import('../server/storage.js');
  assert.equal(sniff(Buffer.from('89504e470d0a1a0a0000', 'hex')).ext, 'png');
  assert.equal(sniff(Buffer.from('OggS\0\0\0\0\0\0\0\0')).kind, 'audio');
  assert.equal(sniff(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')), null);
  assert.equal(sniff(Buffer.from('<html><script>')), null);
});

test('optimizer lowers loss on synthetic history from a different memory model', async () => {
  const { fit, loss } = await import('../server/optimizer.js');
  const truth = DEFAULT_W.map((x, i) => (i < 4 ? x * 0.4 : x));
  const m = model(truth);
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const seqs = [];
  for (let c = 0; c < 150; c++) {
    let ts = 0, s = m.initS(3), d = m.initD(3);
    const seq = [{ ts, rating: 3 }];
    for (let k = 0; k < 6; k++) {
      const ivl = Math.max(1, Math.round(s * (0.6 + rnd())));
      ts += ivl * DAY;
      const r = m.retrievability(ivl, s);
      const g = rnd() < r ? 3 : 1;
      seq.push({ ts, rating: g });
      s = g === 1 ? m.forgetS(d, s, r) : m.recallS(d, s, r, g);
      d = m.nextD(d, g);
    }
    seqs.push(seq);
  }
  const r = fit(seqs, { steps: 60 });
  assert.ok(r.after < r.before, `${r.after} < ${r.before}`);
  assert.ok(r.after <= loss(DEFAULT_W, seqs));
});
