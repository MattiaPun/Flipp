// Set page: study launcher, card list (search, select + bulk actions, drag to reorder), card editor, import.
import { html, useState, useRef, useEffect } from '/vendor/htm-preact.js';
import { api, useAsync, useSubmit, formData, toast, Md, Icon, Modal, prefs } from '/ui.js';
import { parseDelimited, clozeNumbers, plain } from '/lib.js';
import { MODES } from '/pages/study.js';

const dupKey = (s) => plain(s).toLowerCase().replace(/\s+/g, ' ').trim();

function status(c) {
  const p = c.progress || [];
  if (!p.length || p.every((x) => x.state === 0 && !x.suspended)) return { label: 'new', cls: '' };
  if (p.some((x) => x.suspended)) return { label: p.some((x) => x.leech) ? 'leech · suspended' : 'suspended', cls: 'warn' };
  if (p.some((x) => x.leech)) return { label: 'leech', cls: 'bad' };
  const due = Math.min(...p.filter((x) => x.next_due).map((x) => x.next_due));
  if (due <= Date.now()) return { label: 'due', cls: 'accent' };
  const days = Math.round((due - Date.now()) / 86_400_000);
  return { label: days < 1 ? 'learning' : `in ${days}d`, cls: '' };
}

export function SetPage({ id }) {
  const { data: s, error, reload } = useAsync(() => api(`/sets/${id}`), [id]);
  const [panel, setPanel] = useState(null); // 'add' | 'import' | 'edit-set'
  const [editing, setEditing] = useState(null);
  const [selected, setSelected] = useState(new Set());
  const [filter, setFilter] = useState('');
  const [order, setOrder] = useState(null); // card ids while dragging
  if (error) return html`<p class="error">${error.message}</p>`;
  if (!s) return null;
  const canEdit = s.course.canEdit;
  const byId = new Map(s.cards.map((c) => [c.id, c]));
  let cards = order ? order.map((x) => byId.get(x)).filter(Boolean) : s.cards;
  if (filter) {
    const f = filter.toLowerCase();
    cards = cards.filter((c) => `${c.front} ${c.back} ${c.tags} ${c.notes}`.toLowerCase().includes(f));
  }
  const toggle = (cid) => { const n = new Set(selected); n.has(cid) ? n.delete(cid) : n.add(cid); setSelected(n); };
  const star = async (c) => { await api(`/cards/${c.id}/star`, { method: 'POST', body: { starred: !c.starred } }).catch((e) => toast(e.message)); reload(); };
  const delCard = async (c) => { if (confirm('Delete this card?')) { await api(`/cards/${c.id}`, { method: 'DELETE' }).catch((e) => toast(e.message)); reload(); } };
  const schedule = async (c, action) => { await api(`/cards/${c.id}/schedule`, { method: 'POST', body: { action } }).then(() => toast('Done'), (e) => toast(e.message)); reload(); };
  const delSet = async () => { if (confirm(`Delete set "${s.title}" and its ${s.cards.length} cards?`)) { await api(`/sets/${id}`, { method: 'DELETE' }); location.hash = `#/course/${s.course_id}`; } };
  const saveSet = async (e) => {
    e.preventDefault();
    const f = formData(e);
    try { await api(`/sets/${id}`, { method: 'PUT', body: { title: f.title, description: f.description, reverse: f.reverse === 'on' } }); }
    catch (err) { return toast(err.message); } // keep the form open so the edits aren't lost
    setPanel(null); reload();
  };
  const addCard = async (c, force = false) => {
    try { await api(`/sets/${id}/cards`, { method: 'POST', body: { ...c, force } }); }
    catch (e) {
      if (e.code === 'duplicate' && confirm('A card with this front already exists in this set. Add it anyway?')) return addCard(c, true);
      throw e;
    }
    reload();
  };

  return html`<div class="stack">
    <a class="small muted" href=${`#/course/${s.course_id}`}>← ${s.course.icon || '📚'} ${s.course.title}</a>
    ${panel === 'edit-set'
      ? html`<form class="panel col" onSubmit=${saveSet}>
          <label class="field">Title<input class="input" name="title" value=${s.title} required maxlength="120" /></label>
          <label class="field">Description<input class="input" name="description" value=${s.description} /></label>
          <label class="check"><input type="checkbox" name="reverse" checked=${!!s.reverse} /> Also learn in reverse (definition → term) in spaced repetition</label>
          <div class="row"><button class="btn primary">Save</button><button type="button" class="btn ghost" onClick=${() => setPanel(null)}>Cancel</button><span class="grow" /><button type="button" class="btn ghost danger" onClick=${delSet}>Delete set</button></div>
        </form>`
      : html`<div class="row between"><div><h1>${s.title}</h1>${s.description && html`<p class="muted">${s.description}</p>`}
          <p class="small faint">${s.cards.length} cards${s.reverse ? ' · learned in both directions' : ''}</p></div>
          ${canEdit && html`<button class="btn sm" onClick=${() => setPanel('edit-set')}>Edit</button>`}</div>`}

    ${s.cards.length > 0 && html`<${Launcher} set=${s} />`}

    <div class="section">
      <div class="row between" style="margin-bottom:12px">
        <div class="section-title" style="margin:0">Cards</div>
        <div class="row">
          ${s.cards.length > 5 && html`<input class="input compact" style="width:160px" type="search" placeholder="Search cards…" value=${filter} onInput=${(e) => setFilter(e.target.value)} aria-label="Search cards" />`}
          ${s.cards.length > 0 && html`<a class="btn sm ghost" href=${`/api/sets/${id}/export.csv`} download>Export CSV</a>`}
          ${canEdit && html`<button class="btn sm ghost" onClick=${() => setPanel(panel === 'import' ? null : 'import')}>Import</button>
            <button class="btn sm" onClick=${() => setPanel(panel === 'add' ? null : 'add')}>+ Add card</button>`}
        </div>
      </div>
      ${panel === 'import' && html`<div style="margin-bottom:12px"><${Import} set=${s} onDone=${() => { setPanel(null); reload(); }} /></div>`}
      ${panel === 'add' && html`<div style="margin-bottom:12px"><${CardEditor} onSave=${addCard} onCancel=${() => setPanel(null)} /></div>`}
      ${selected.size > 0 && html`<${BulkBar} set=${s} ids=${[...selected]} canEdit=${canEdit} onDone=${() => { setSelected(new Set()); reload(); }} onClear=${() => setSelected(new Set())} />`}
      ${!s.cards.length && panel !== 'add' && panel !== 'import' && html`<p class="muted">No cards yet. ${canEdit ? 'Add some, or paste a list with Import.' : ''}</p>`}
      ${cards.length > 0 && html`<div class="panel cardlist" style="padding:0">
        <div class="cardrow head small muted">
          <label class="check"><input type="checkbox" checked=${selected.size === cards.length} onChange=${(e) => setSelected(e.target.checked ? new Set(cards.map((c) => c.id)) : new Set())} aria-label="Select all" /> ${selected.size ? `${selected.size} selected` : 'Select'}</label>
        </div>
        ${cards.map((c) => editing === c.id
          ? html`<div style="padding:8px" key=${c.id}><${CardEditor} card=${c} onSave=${async (v) => { await api(`/cards/${c.id}`, { method: 'PUT', body: v }); setEditing(null); reload(); }} onCancel=${() => setEditing(null)} /></div>`
          : html`<${CardRow} key=${c.id} c=${c} canEdit=${canEdit} draggable=${canEdit && !filter} selected=${selected.has(c.id)} onSelect=${() => toggle(c.id)}
              onStar=${() => star(c)} onEdit=${() => setEditing(c.id)} onDelete=${() => delCard(c)} onSchedule=${(a) => schedule(c, a)}
              drag=${{ order: order || s.cards.map((x) => x.id), setOrder, commit: async (ids) => { setOrder(ids); try { await api(`/sets/${id}/order`, { method: 'PUT', body: { ids } }); await reload(); } catch (e) { toast(e.message); } setOrder(null); } }} />`)}
      </div>`}
    </div>
  </div>`;
}

function Launcher({ set }) {
  const [opts, setOpts] = useState(() => prefs.get('launcher', { dir: 'front', starred: false, len: '' }));
  const update = (o) => { const n = { ...opts, ...o }; setOpts(n); prefs.set('launcher', n); };
  const starredCount = set.cards.filter((c) => c.starred).length;
  const url = (mode) => {
    const p = new URLSearchParams({ set: set.id, mode });
    if (mode !== 'learn' && opts.dir !== 'front') p.set('dir', opts.dir);
    if (opts.starred && starredCount) p.set('starred', '1');
    if (opts.len) { const [k, v] = opts.len.split(':'); p.set(k, v); }
    return `#/study?${p}`;
  };
  return html`<div>
    <div class="modes">${Object.entries(MODES).map(([m, x]) => html`<a class="mode" href=${url(m)}><b>${x.title}</b><span>${x.sub}</span></a>`)}</div>
    <div class="row launcher-opts">
      <label class="field inline">Direction<select class="input compact" value=${opts.dir} onChange=${(e) => update({ dir: e.target.value })}>
        <option value="front">Term → definition</option><option value="back">Definition → term</option><option value="both">Both</option></select></label>
      <label class="field inline">Session<select class="input compact" value=${opts.len} onChange=${(e) => update({ len: e.target.value })}>
        <option value="">Until done</option><option value="len:10">10 cards</option><option value="len:20">20 cards</option><option value="len:50">50 cards</option>
        <option value="min:5">5 minutes</option><option value="min:10">10 minutes</option><option value="min:20">20 minutes</option></select></label>
      ${starredCount > 0 && html`<label class="check"><input type="checkbox" checked=${opts.starred} onChange=${(e) => update({ starred: e.target.checked })} /> Only starred (${starredCount})</label>`}
    </div>
  </div>`;
}

function CardRow({ c, canEdit, draggable, selected, onSelect, onStar, onEdit, onDelete, onSchedule, drag }) {
  const st = status(c);
  const front = c.type === 'cloze' ? c.front.replace(/\{\{c(\d+)::([\s\S]*?)(::[\s\S]*?)?\}\}/g, '[$2]') : c.front;
  // Drag handle: pointer events so it works with touch, mouse and pen.
  const onHandleDown = (e) => {
    if (!draggable) return;
    e.preventDefault();
    const start = drag.order;
    let current = start;
    const move = (ev) => {
      const row = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('[data-card]');
      if (!row) return;
      const over = Number(row.dataset.card);
      if (over === c.id) return;
      const without = current.filter((x) => x !== c.id);
      const idx = without.indexOf(over);
      const before = ev.clientY < row.getBoundingClientRect().top + row.offsetHeight / 2;
      current = [...without.slice(0, before ? idx : idx + 1), c.id, ...without.slice(before ? idx : idx + 1)];
      drag.setOrder(current);
    };
    const up = () => {
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
      removeEventListener('pointercancel', up);
      if (current.join() !== start.join()) drag.commit(current); else drag.setOrder(null);
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
    addEventListener('pointercancel', up);
  };
  return html`<div class="cardrow ${selected ? 'selected' : ''}" data-card=${c.id}>
    <div class="row" style="gap:6px;align-items:flex-start;flex-wrap:nowrap">
      ${draggable && html`<span class="grip" onPointerDown=${onHandleDown} title="Drag to reorder" aria-hidden="true"><${Icon} name="grip" size=${16} /></span>`}
      <input type="checkbox" checked=${selected} onChange=${onSelect} aria-label="Select card" style="margin-top:4px" />
      <div class="grow" style="min-width:0">${c.image && html`<img src=${c.image} alt="" />`}<${Md} src=${front} />
        <div class="row chips">${c.type === 'cloze' && html`<span class="tag">cloze ×${clozeNumbers(c.front).length}</span>`}
          <span class="tag ${st.cls}">${st.label}</span>${c.audio && html`<span class="tag">♪ audio</span>`}${c.tags && c.tags.split(',').map((t) => html`<span class="tag">#${t}</span>`)}</div></div>
    </div>
    <${Md} class="back" src=${c.type === 'cloze' ? c.back || '' : c.back} />
    <div class="row actions" style="gap:2px;flex-wrap:nowrap">
      <button class="btn ghost icon-btn star ${c.starred ? 'on' : ''}" title="Star" aria-label="Star" aria-pressed=${!!c.starred} onClick=${onStar}><${Icon} name="star" fill=${!!c.starred} /></button>
      ${canEdit && html`<button class="btn ghost sm" onClick=${onEdit}>Edit</button>`}
      <details class="menu"><summary class="btn ghost sm" aria-label="More">⋯</summary><div class="menu-list right">
        ${(c.progress || []).some((x) => x.suspended) ? html`<button onClick=${() => onSchedule('unsuspend')}>Unsuspend</button>` : html`<button onClick=${() => onSchedule('suspend')}>Suspend</button>`}
        <button onClick=${() => onSchedule('bury')}>Bury until tomorrow</button>
        <button onClick=${() => confirm('Forget all progress on this card?') && onSchedule('reset')}>Reset progress</button>
        ${canEdit && html`<button class="danger" onClick=${onDelete}>Delete</button>`}
      </div></details>
    </div>
  </div>`;
}

function BulkBar({ set, ids, canEdit, onDone, onClear }) {
  const [busy, setBusy] = useState(false);
  const run = async (action, extra = {}) => {
    if (action === 'delete' && !confirm(`Delete ${ids.length} cards?`)) return;
    setBusy(true);
    try { const r = await api('/cards/bulk', { method: 'POST', body: { ids, action, ...extra } }); toast(`${r.count} cards updated`); onDone(); }
    catch (e) { toast(e.message); }
    finally { setBusy(false); }
  };
  const tag = (action) => { const t = prompt(action === 'tag' ? 'Add tag:' : 'Remove tag:'); if (t) run(action, { tag: t }); };
  const others = set.siblings.filter((x) => x.id !== set.id);
  return html`<div class="bulkbar pop" role="toolbar" aria-label="Bulk actions">
    <b>${ids.length} selected</b>
    <button class="btn sm" disabled=${busy} onClick=${() => run('star')}>Star</button>
    <button class="btn sm" disabled=${busy} onClick=${() => run('unstar')}>Unstar</button>
    <button class="btn sm" disabled=${busy} onClick=${() => run('suspend')}>Suspend</button>
    <button class="btn sm" disabled=${busy} onClick=${() => run('unsuspend')}>Unsuspend</button>
    ${canEdit && html`
      <button class="btn sm" disabled=${busy} onClick=${() => tag('tag')}>+ Tag</button>
      <button class="btn sm" disabled=${busy} onClick=${() => tag('untag')}>− Tag</button>
      ${others.length > 0 && html`<select class="input compact" style="width:auto" disabled=${busy} onChange=${(e) => { const [a, sid] = e.target.value.split(':'); e.target.value = ''; if (sid) run(a, { setId: Number(sid) }); }}>
        <option value="">Move / copy to…</option>
        ${others.map((o) => html`<option value=${`move:${o.id}`}>Move to “${o.title}”</option>`)}
        ${others.map((o) => html`<option value=${`copy:${o.id}`}>Copy to “${o.title}”</option>`)}
      </select>`}
      <button class="btn sm danger" disabled=${busy} onClick=${() => run('delete')}>Delete</button>`}
    <span class="grow" /><button class="btn ghost sm" onClick=${onClear}>Clear</button>
  </div>`;
}

// ---------- Card editor ----------
async function uploadFile(file) {
  return api('/uploads', { method: 'POST', file });
}

function MdField({ label, value, onChange, preview, placeholder, cloze, required, rows = 3, autoFocus }) {
  const ref = useRef();
  useEffect(() => { if (autoFocus) ref.current?.focus(); }, []);
  const wrap = (before, after = before, fallback = '') => {
    const t = ref.current;
    const { selectionStart: a, selectionEnd: b } = t;
    const sel = value.slice(a, b) || fallback;
    onChange(value.slice(0, a) + before + sel + after + value.slice(b));
    requestAnimationFrame(() => { t.focus(); t.setSelectionRange(a + before.length, a + before.length + sel.length); });
  };
  const insertCloze = () => {
    const next = Math.max(0, ...clozeNumbers(value)) + 1;
    wrap(`{{c${next}::`, '}}', 'answer');
  };
  const insertAt = (text) => {
    const t = ref.current;
    const a = t?.selectionStart ?? value.length;
    onChange(value.slice(0, a) + text + value.slice(t?.selectionEnd ?? a));
  };
  // Paste or drop an image straight into the text (22).
  const handleFiles = async (files) => {
    for (const f of [...files].filter((x) => x.type.startsWith('image/'))) {
      try { const r = await uploadFile(f); insertAt(`![](${r.url})`); } catch (e) { toast(e.message); }
    }
  };
  const onPaste = (e) => { if ([...(e.clipboardData?.files || [])].some((f) => f.type.startsWith('image/'))) { e.preventDefault(); handleFiles(e.clipboardData.files); } };
  const onDrop = (e) => { if (e.dataTransfer?.files?.length) { e.preventDefault(); handleFiles(e.dataTransfer.files); } };
  const keys = (e) => {
    if (!(e.metaKey || e.ctrlKey)) return;
    if (e.key === 'b') { e.preventDefault(); wrap('**'); }
    else if (e.key === 'i') { e.preventDefault(); wrap('*'); }
    else if (e.key === 'e') { e.preventDefault(); wrap('`'); }
    else if (cloze && e.shiftKey && e.key.toLowerCase() === 'c') { e.preventDefault(); insertCloze(); }
  };
  return html`<div class="field grow md-field">
    <div class="row between"><span>${label}</span>
      <div class="md-toolbar" role="toolbar" aria-label=${`${label} formatting`}>
        <button type="button" title="Bold (⌘B)" onClick=${() => wrap('**')}><b>B</b></button>
        <button type="button" title="Italic (⌘I)" onClick=${() => wrap('*')}><i>I</i></button>
        <button type="button" title="Code (⌘E)" onClick=${() => wrap('`')}>${'</>'}</button>
        <button type="button" title="Math" onClick=${() => wrap('$', '$', 'x^2')}>∑</button>
        <button type="button" title="List" onClick=${() => insertAt('\n- ')}>•</button>
        ${cloze && html`<button type="button" title="Cloze deletion (⌘⇧C)" onClick=${insertCloze}>[…]</button>`}
      </div>
    </div>
    <div class="split ${preview ? 'on' : ''}">
      <textarea class="input" ref=${ref} rows=${rows} value=${value} required=${required} placeholder=${placeholder}
        onInput=${(e) => onChange(e.target.value)} onKeyDown=${keys} onPaste=${onPaste} onDrop=${onDrop} onDragOver=${(e) => e.preventDefault()} />
      ${preview && html`<div class="input preview"><${Md} src=${value || '*Preview*'} /></div>`}
    </div>
  </div>`;
}

function AudioField({ value, onChange }) {
  const [rec, setRec] = useState(null);
  const start = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mime = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus'].find((m) => window.MediaRecorder?.isTypeSupported?.(m)) || '';
      const r = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      const chunks = [];
      r.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      r.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunks, { type: r.mimeType || 'audio/webm' });
        try { onChange((await uploadFile(blob)).url); } catch (e) { toast(e.message); }
        setRec(null);
      };
      r.start();
      setRec(r);
      setTimeout(() => r.state === 'recording' && r.stop(), 30_000); // 30 s max
    } catch (e) { toast(e.name === 'NotAllowedError' ? 'Microphone access was denied' : `Can't record: ${e.message}`); }
  };
  const pick = async (e) => { const f = e.target.files[0]; if (f) { try { const r = await uploadFile(f); if (r.kind !== 'audio') throw new Error('Pick an audio file'); onChange(r.url); } catch (err) { toast(err.message); } } };
  return html`<div class="row" style="gap:6px">
    ${value ? html`<audio controls src=${value} style="height:32px;max-width:220px" /><button type="button" class="btn sm ghost" onClick=${() => onChange(null)}>Remove audio</button>`
      : rec ? html`<button type="button" class="btn sm danger" onClick=${() => rec.stop()}><${Icon} name="pause" size=${14} /> Stop recording</button>`
        : html`${navigator.mediaDevices?.getUserMedia && window.MediaRecorder && html`<button type="button" class="btn sm ghost" onClick=${start}><${Icon} name="mic" size=${14} /> Record</button>`}
          <label class="btn sm ghost">Audio file<input type="file" accept="audio/*" hidden onChange=${pick} /></label>`}
  </div>`;
}

export function CardEditor({ card, onSave, onCancel }) {
  const blank = { type: 'basic', front: '', back: '', notes: '', mnemonic: '', example: '', tags: '', image: null, audio: null };
  const [c, setC] = useState({ ...blank, ...(card || {}) });
  const [preview, setPreview] = useState(prefs.get('editorPreview', false));
  const [more, setMore] = useState(!!(card?.notes || card?.mnemonic || card?.example));
  const set = (k) => (v) => setC((x) => ({ ...x, [k]: v }));
  const [save, st] = useSubmit(async () => {
    await onSave({ type: c.type, front: c.front, back: c.back, notes: c.notes, mnemonic: c.mnemonic, example: c.example, tags: c.tags, image: c.image, audio: c.audio });
    if (!card) { setC({ ...blank, type: c.type, tags: c.tags }); document.querySelector('.card-editor textarea')?.focus(); }
  });
  const uploadImage = async (e) => { const f = e.target.files[0]; if (f) { try { const r = await uploadFile(f); if (r.kind !== 'image') throw new Error('Pick an image'); set('image')(r.url); } catch (err) { toast(err.message); } } };
  const keys = (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) save(e); };
  const cloze = c.type === 'cloze';
  return html`<form class="panel col card-editor" onSubmit=${save} onKeyDown=${keys}>
    <div class="row between">
      <div class="segmented" role="radiogroup" aria-label="Card type">
        <button type="button" role="radio" aria-checked=${!cloze} class=${!cloze ? 'on' : ''} onClick=${() => set('type')('basic')}>Basic</button>
        <button type="button" role="radio" aria-checked=${cloze} class=${cloze ? 'on' : ''} onClick=${() => set('type')('cloze')}>Cloze</button>
      </div>
      <label class="check small"><input type="checkbox" checked=${preview} onChange=${(e) => { setPreview(e.target.checked); prefs.set('editorPreview', e.target.checked); }} /> Live preview</label>
    </div>
    ${cloze && html`<p class="small faint">Wrap answers in <code>{{c1::…}}</code> — each number becomes its own card. Add a hint with <code>{{c1::answer::hint}}</code>.</p>`}
    <div class="row" style="align-items:stretch">
      <${MdField} label=${cloze ? 'Text' : 'Front · term'} value=${c.front} onChange=${set('front')} preview=${preview} cloze=${cloze} required autoFocus=${!card}
        placeholder=${cloze ? 'The capital of Sweden is {{c1::Stockholm}}.' : 'Markdown, `code`, $LaTeX$ — paste or drop images'} />
      <${MdField} label=${cloze ? 'Extra (shown with the answer)' : 'Back · definition'} value=${c.back} onChange=${set('back')} preview=${preview} />
    </div>
    ${c.image && html`<div class="row"><img src=${c.image} style="max-height:80px;border-radius:8px" alt="" /><button type="button" class="btn sm ghost" onClick=${() => set('image')(null)}>Remove image</button></div>`}
    <div class="row">
      <label class="btn sm ghost">Image<input type="file" accept="image/png,image/jpeg,image/gif,image/webp" hidden onChange=${uploadImage} /></label>
      <${AudioField} value=${c.audio} onChange=${set('audio')} />
      <input class="input compact grow" style="width:auto;min-width:140px" placeholder="tags, comma separated" value=${c.tags} onInput=${(e) => set('tags')(e.target.value)} aria-label="Tags" />
      <button type="button" class="btn sm ghost" onClick=${() => setMore(!more)}>${more ? 'Fewer fields' : 'More fields'}</button>
    </div>
    ${more && html`<div class="col">
      <${MdField} label="Mnemonic" value=${c.mnemonic} onChange=${set('mnemonic')} preview=${preview} rows=${2} />
      <${MdField} label="Example sentence" value=${c.example} onChange=${set('example')} preview=${preview} rows=${2} />
      <${MdField} label="Notes" value=${c.notes} onChange=${set('notes')} preview=${preview} rows=${2} />
    </div>`}
    ${st.error && html`<p class="error">${st.error}</p>`}
    <div class="row">
      <button class="btn primary" disabled=${st.busy}>${card ? 'Save' : 'Add card'} <kbd>⌘↵</kbd></button>
      ${onCancel && html`<button type="button" class="btn ghost" onClick=${onCancel}>Cancel</button>`}
    </div>
  </form>`;
}

function Import({ set, onDone }) {
  const [text, setText] = useState('');
  const [delim, setDelim] = useState('auto');
  const [skipDup, setSkipDup] = useState(true);
  let rows = parseDelimited(text, delim === 'tab' ? '\t' : delim);
  if (rows[0] && rows[0][0].toLowerCase() === 'front' && rows[0][1].split(',')[0].trim().toLowerCase().startsWith('back')) rows = rows.slice(1);
  const existing = new Set(set.cards.map((c) => dupKey(c.front)));
  const dups = rows.filter(([f]) => existing.has(dupKey(f))).length;
  const [submit, st] = useSubmit(async () => {
    const r = await api(`/sets/${set.id}/cards`, { method: 'POST', body: { skipDuplicates: skipDup, cards: rows.map(([front, back]) => ({ front, back, type: /\{\{c\d+::/.test(front) ? 'cloze' : 'basic' })) } });
    toast(`Imported ${r.ids.length} cards${r.skipped ? `, skipped ${r.skipped} duplicates` : ''}`);
    onDone();
  });
  return html`<form class="panel col pop" onSubmit=${submit}>
    <p class="small muted">Paste from Quizlet (Export → tab between term and definition, new line between cards), a spreadsheet, or CSV. For Anki decks use the course menu → Import Anki deck.</p>
    <textarea class="input" rows="8" value=${text} onInput=${(e) => setText(e.target.value)} placeholder=${'hund\tdog\nkatt\tcat'} style="font-family:var(--mono);font-size:13px" />
    <div class="row">
      <select class="input compact" style="width:auto" value=${delim} onChange=${(e) => setDelim(e.target.value)}>
        <option value="auto">Detect separator</option><option value="tab">Tab</option><option value=",">Comma</option><option value=";">Semicolon</option></select>
      ${dups > 0 && html`<label class="check small"><input type="checkbox" checked=${skipDup} onChange=${(e) => setSkipDup(e.target.checked)} /> Skip ${dups} duplicate${dups === 1 ? '' : 's'}</label>`}
      <span class="small muted grow">${rows.length} card${rows.length === 1 ? '' : 's'} detected</span>
      <button class="btn primary" disabled=${!rows.length || st.busy}>Import</button>
    </div>
    ${rows.length > 0 && html`<div class="import-preview small">${rows.slice(0, 3).map(([f, b]) => html`<div class="row between"><span>${f}</span><span class="muted">${b}</span></div>`)}${rows.length > 3 && html`<div class="faint">…and ${rows.length - 3} more</div>`}</div>`}
    ${st.error && html`<p class="error">${st.error}</p>`}
  </form>`;
}

export { Modal };
