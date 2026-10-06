// Pure helpers shared by the browser app and the server tests. No DOM, no Node APIs.

export function levenshtein(a, b) {
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

// Markdown/LaTeX-ish source -> plain text for comparison, TTS and match tiles.
export const plain = (s) =>
  String(s || '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`#>~$\\]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

const norm = (s) => plain(s).normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N} ]/gu, '').replace(/\s+/g, ' ').trim();

// Grade a typed answer. Accepts the whole answer or any alternative separated by ; , / or newline.
// Returns 'exact' | 'close' (minor typo / accents) | 'wrong'.
export function grade(input, answer) {
  const got = norm(input);
  if (!got) return 'wrong';
  const raw = plain(answer);
  const loose = (s) => plain(s).toLowerCase().replace(/[^\p{L}\p{M}\p{N} ]/gu, '').replace(/\s+/g, ' ').trim();
  let best = 'wrong';
  for (const alt of [raw, ...raw.split(/[;,/\n]| or /)]) {
    const opt = norm(alt);
    if (!opt) continue;
    if (got === opt) return loose(input).normalize() === loose(alt).normalize() ? 'exact' : 'close'; // 'close' = accents differ
    const tolerance = opt.length < 4 ? 0 : Math.max(1, Math.round(opt.length / 4));
    if (levenshtein(got, opt) <= tolerance) best = 'close';
  }
  return best;
}

// Parse Quizlet / TSV / CSV paste. delimiter: '\t' | ',' | ';' | 'auto'. Supports "quoted, fields" and "" escapes.
export function parseDelimited(text, delimiter = 'auto') {
  text = String(text).replace(/\r\n?/g, '\n');
  if (delimiter === 'auto') delimiter = text.includes('\t') ? '\t' : text.includes(';') && !text.includes(',') ? ';' : ',';
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"' && field === '') quoted = true;
    else if (c === delimiter) { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  row.push(field);
  rows.push(row);
  return rows
    .map((r) => [r[0]?.trim() ?? '', r.slice(1).join(delimiter).trim()])
    .filter(([f, b]) => f || b);
}

export const toCSV = (rows) =>
  rows.map((r) => r.map((v) => (/[",\n\r]/.test(v ?? '') ? `"${String(v).replace(/"/g, '""')}"` : v ?? '')).join(',')).join('\r\n') + '\r\n';

export function shuffle(arr, rand = Math.random) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// In-session queue. A missed card ("Again"/"Hard"/wrong) re-enters the queue 3–5 cards later and
// must then be answered correctly twice in a row before it leaves the session.
export class StudyQueue {
  constructor(cards, rand = Math.random) {
    this.cards = new Map(cards.map((c) => [c.id, c]));
    this.q = cards.map((c) => c.id);
    this.need = new Map(); // id -> correct answers still required
    this.miss = new Map(); // id -> times missed this session
    this.firstTry = new Map(); // id -> correct on first attempt?
    this.history = [];
    this.rand = rand;
  }
  get current() { return this.cards.get(this.q[0]); }
  get total() { return this.cards.size; }
  get finished() { return this.total - new Set(this.q).size; }
  get done() { return this.q.length === 0; }

  answer(correct, meta) {
    this.history.push({ q: [...this.q], need: new Map(this.need), miss: new Map(this.miss), firstTry: new Map(this.firstTry), meta });
    const id = this.q.shift();
    if (!this.firstTry.has(id)) this.firstTry.set(id, correct);
    if (!correct) {
      this.miss.set(id, (this.miss.get(id) || 0) + 1);
      this.need.set(id, 2);
      this.#reinsert(id);
    } else if (this.need.get(id) > 0) {
      const left = this.need.get(id) - 1;
      this.need.set(id, left);
      if (left > 0) this.#reinsert(id);
    }
  }

  undo() {
    const h = this.history.pop();
    if (!h) return null;
    Object.assign(this, { q: h.q, need: h.need, miss: h.miss, firstTry: h.firstTry });
    return h.meta;
  }

  #reinsert(id) {
    const gap = 3 + Math.floor(this.rand() * 3); // 3..5 other cards in between
    this.q.splice(Math.min(gap, this.q.length), 0, id);
  }
}
