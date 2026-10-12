// Library (public courses), tags overview, leeches list.
import { html, useState } from '/vendor/htm-preact.js';
import { api, useAsync, toast, Md, Illustration } from '/ui.js';
import { CourseTile } from '/pages/home.js';
import { sides } from '/lib.js';

export function Library() {
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const list = useAsync(() => api(`/library?q=${encodeURIComponent(query)}`), [query]);
  const save = async (c, saved) => {
    try { await api(`/courses/${c.id}/save`, { method: 'POST', body: { saved } }); toast(saved ? 'Added to your courses' : 'Removed from your courses'); list.reload(); } catch (e) { toast(e.message); }
  };
  const clone = async (c) => {
    try { const r = await api(`/courses/${c.id}/clone`, { method: 'POST' }); location.hash = `#/course/${r.id}`; toast('Copied into your courses'); } catch (e) { toast(e.message); }
  };
  return html`<div class="stack">
    <h1>Library</h1>
    <p class="muted">Public courses shared on this instance. Add one to your courses to study it, or make your own editable copy.</p>
    <form class="row" onSubmit=${(e) => { e.preventDefault(); setQuery(q); }}>
      <input class="input grow" style="width:auto" type="search" placeholder="Search courses…" value=${q} onInput=${(e) => setQ(e.target.value)} />
      <button class="btn">Search</button>
    </form>
    ${list.data && !list.data.length && html`<div class="panel empty"><${Illustration} /><p class="muted">${query ? 'No matching courses.' : 'No shared courses yet. Course owners can share theirs from the course menu.'}</p></div>`}
    <div class="grid">${(list.data || []).map((c) => html`<${CourseTile} c=${{ ...c, owned: c.owned }} extra=${html`
      ${c.description && html`<p class="small muted clamp2" style="margin-top:6px">${c.description}</p>`}
      <div class="row" style="margin-top:10px" onClick=${(e) => e.preventDefault()}>
        ${!c.owned && html`<button class="btn sm ${c.saved ? '' : 'primary'}" onClick=${() => save(c, !c.saved)}>${c.saved ? 'Added' : 'Add to my courses'}</button>`}
        <button class="btn sm ghost" onClick=${() => clone(c)}>Make a copy</button>
        <span class="small faint">${c.learners} learner${c.learners == 1 ? '' : 's'}</span>
      </div>`} />`)}</div>
  </div>`;
}

export function Tags() {
  const { data, error } = useAsync(() => api('/tags'));
  return html`<div class="stack">
    <h1>Tags</h1>
    <p class="muted">Study every card with a tag, across all your courses. Add tags to cards in the card editor or with bulk actions.</p>
    ${error && html`<p class="error">${error.message}</p>`}
    ${data && !data.length && html`<p class="muted">No tagged cards yet.</p>`}
    <div class="col" style="gap:8px">${(data || []).map((t) => html`<div class="panel row between">
      <div><b>#${t.tag}</b> <span class="small muted">${t.count} card${t.count === 1 ? '' : 's'}</span></div>
      <div class="row">
        <a class="btn sm primary" href=${`#/study?tag=${encodeURIComponent(t.tag)}&mode=learn`}>Learn</a>
        <a class="btn sm" href=${`#/study?tag=${encodeURIComponent(t.tag)}&mode=flip`}>Flashcards</a>
        <a class="btn sm" href=${`#/study?tag=${encodeURIComponent(t.tag)}&mode=write`}>Write</a>
      </div></div>`)}</div>
  </div>`;
}

export function Leeches() {
  const list = useAsync(() => api('/leeches'));
  const act = async (id, action) => { try { await api(`/cards/${id}/schedule`, { method: 'POST', body: { action } }); list.reload(); toast(action === 'unsuspend' ? 'Back in rotation' : 'Progress reset'); } catch (e) { toast(e.message); } };
  return html`<div class="stack">
    <h1>Leeches</h1>
    <p class="muted">Cards you've forgotten many times. They're often too long or ambiguous. Rewrite or split them, or add a mnemonic, then put them back.</p>
    ${list.data && !list.data.length && html`<div class="panel empty"><${Illustration} /><p class="muted">No leeches. Every card is sticking.</p></div>`}
    <div class="panel" style="padding:0">${(list.data || []).map((c) => { const s = sides(c, c.variant); return html`<div class="cardrow">
      <div><${Md} src=${s.prompt} /><div class="small faint">${c.icon} ${c.course_title} · ${c.set_title}</div></div>
      <${Md} class="back" src=${s.answer} />
      <div class="col actions" style="gap:4px;align-items:flex-end">
        <span class="small" style="color:var(--bad)">${c.lapses} lapses${c.suspended ? ' · suspended' : ''}</span>
        <div class="row" style="gap:2px;flex-wrap:nowrap">
          <a class="btn ghost sm" href=${`#/set/${c.set_id}`}>Edit</a>
          <button class="btn ghost sm" onClick=${() => act(c.id, 'unsuspend')}>Unsuspend</button>
          <button class="btn ghost sm" onClick=${() => confirm('Reset all progress for this card?') && act(c.id, 'reset')}>Reset</button>
        </div>
      </div></div>`; })}</div>
  </div>`;
}
