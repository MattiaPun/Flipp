// Home: greeting, streak/XP/due/goal, daily quests, courses; plus the course create/edit form and the Quests list.
import { html, useState } from '/vendor/htm-preact.js';
import { api, useAsync, useSubmit, formData, Icon, Illustration } from '/ui.js';
import { QUEST_XP } from '/lib.js';
import { ImportCourseButton } from '/pages/transfer.js';

export function Home({ me }) {
  const courses = useAsync(() => api('/courses'));
  const stats = useAsync(() => api('/stats'));
  const [creating, setCreating] = useState(false);
  const [filter, setFilter] = useState('');
  const h = new Date().getHours();
  const list = (courses.data || []).filter((c) => !filter || `${c.title} ${c.tags}`.toLowerCase().includes(filter.toLowerCase()));
  const s = stats.data;
  // ponytail: ~8 s per card for the time estimate; use the user's real average review time if it matters.
  const goalPct = s?.goal ? Math.min(100, Math.round((s.today / s.goal) * 100)) : null;

  return html`<div class="stack">
    <div class="hello">
      <h1>Good ${h < 12 ? 'morning' : h < 18 ? 'afternoon' : 'evening'}, ${me.user.name.split(' ')[0]}</h1>
      <p>${!s ? '\u00a0' : s.due ? `${s.due} card${s.due === 1 ? '' : 's'} due for review.` : s.today ? `All caught up. ${s.today} review${s.today === 1 ? '' : 's'} today.` : 'Nothing due right now.'}</p>
    </div>
    <div class="stats four">
      <div class="stat flame"><b><${Icon} name="flame" size=${22} />${s ? s.streak : '–'}</b><span>day streak${s?.freezes ? html` · <span class="freeze" title="Streak freezes held. One covers a day you miss."><${Icon} name="snow" size=${12} /> ${s.freezes}</span>` : ''}</span></div>
      <div class="stat xp"><b><${Icon} name="bolt" size=${22} />${s ? s.xp : '–'}</b><span>XP today</span></div>
      <div class="stat"><b><${Icon} name="cards" size=${22} />${s ? s.due : '–'}</b><span>cards due</span></div>
      <div class="stat"><b><${Icon} name="check" size=${22} />${s ? s.today : '–'}${s?.goal ? html`<small> / ${s.goal}</small>` : ''}</b><span>reviews today</span>
        ${goalPct !== null && html`<div class="progress thin" style="margin-top:8px"><i style=${{ width: goalPct + '%' }} /></div>`}</div>
    </div>
    ${s?.due > 0 && html`<div class="today">
      <div><b>Today's review</b><span>${s.due} card${s.due === 1 ? '' : 's'} · about ${Math.max(1, Math.round((s.due * 8) / 60))} min</span></div>
      <a class="btn primary lg" href="#/study?mode=learn">Start review</a></div>`}
    ${s?.quests && html`<div class="panel quests-panel"><div class="section-title">Daily quests</div><${Quests} quests=${s.quests} /></div>`}
    <div class="quick-links">
      <a class="btn sm ghost" href="#/stats"><${Icon} name="chart" /> Statistics</a>
      <a class="btn sm ghost" href="#/library"><${Icon} name="book" /> Library</a>
      <a class="btn sm ghost" href="#/groups"><${Icon} name="users" /> Groups</a>
      <a class="btn sm ghost" href="#/tags">#  Tags</a>
      <a class="btn sm ghost" href="#/leeches">Leeches</a>
    </div>
    <div class="section">
      <div class="row between" style="margin-bottom:12px">
        <div class="section-title" style="margin:0">Your courses</div>
        <div class="row">
          ${(courses.data?.length || 0) > 4 && html`<input class="input compact course-filter" placeholder="Filter…" value=${filter} onInput=${(e) => setFilter(e.target.value)} aria-label="Filter courses" />`}
          <${ImportCourseButton} />
          <button class="btn sm" onClick=${() => setCreating(!creating)}>${creating ? 'Cancel' : '+ New course'}</button>
        </div>
      </div>
      ${creating && html`<div style="margin-bottom:12px"><${CourseForm} me=${me} onSaved=${(r) => { location.hash = `#/course/${r.id}`; }} onCancel=${() => setCreating(false)} /></div>`}
      ${courses.error && html`<p class="error">${courses.error.message}</p>`}
      ${courses.data && !courses.data.length && !creating && html`<div class="panel empty">
        <${Illustration} /><h2>No courses yet</h2>
        <p class="muted" style="margin:6px 0 16px">A course groups related sets, like "Swedish A1" or "System Design". Create one, or pick one from the library.</p>
        <div class="row" style="justify-content:center"><button class="btn primary" onClick=${() => setCreating(true)}>Create a course</button><a class="btn" href="#/library">Browse the library</a></div></div>`}
      <div class="grid">${list.map((c) => html`<${CourseTile} c=${c} />`)}</div>
    </div>
  </div>`;
}

// Each course gets one of six fixed header colors (c1–c6 in styles.css), stable per id.
export const CourseTile = ({ c, extra }) => html`<a class=${`tile c${(Number(c.id) % 6) + 1}`} href=${`#/course/${c.id}`}>
  <div class="row between" style="align-items:flex-start"><span class="emoji">${c.icon || '📚'}</span>
    <span class="row" style="gap:6px">${c.featured ? html`<span class="tag accent">Featured</span>` : ''}${c.due_count > 0 && html`<span class="badge">${c.due_count} due</span>`}</span></div>
  <h3>${c.title}</h3>
  <p class="small muted">${c.set_count} set${c.set_count == 1 ? '' : 's'} · ${c.card_count} cards${c.visibility === 'public' ? ' · Public' : ''}${!c.owned && c.owner_name ? ` · by ${c.owner_name}` : ''}${c.member_role ? ` · shared (${c.member_role})` : ''}</p>
  ${c.tags && html`<div class="tags">${c.tags.split(',').map((t) => html`<span>#${t.trim()}</span>`)}</div>`}
  ${extra}
</a>`;

export function CourseForm({ me, course, onSaved, onCancel }) {
  const [submit, st] = useSubmit(async (e) => {
    const body = formData(e);
    onSaved(course ? await api(`/courses/${course.id}`, { method: 'PUT', body }) : await api('/courses', { method: 'POST', body }));
  });
  const c = course || {};
  return html`<form class="panel col pop" onSubmit=${submit}>
    <div class="row" style="align-items:flex-end">
      <label class="field" style="width:72px">Icon<input class="input" name="icon" value=${c.icon || '📚'} maxlength="16" style="text-align:center;font-size:20px;padding:5px" /></label>
      <label class="field grow">Title<input class="input" name="title" value=${c.title || ''} required maxlength="120" placeholder="Swedish A1" autofocus /></label>
    </div>
    <label class="field">Description<textarea class="input" name="description" maxlength="2000" rows="2">${c.description || ''}</textarea></label>
    <div class="row" style="align-items:flex-start">
      <label class="field grow">Tags (comma separated)<input class="input" name="tags" value=${c.tags || ''} placeholder="language, beginner" /></label>
      <label class="field" style="width:150px">Speech language<input class="input" name="lang" value=${c.lang || ''} placeholder="sv-SE" list="langs" /></label>
    </div>
    <datalist id="langs">${['en-US', 'en-GB', 'sv-SE', 'de-DE', 'fr-FR', 'es-ES', 'it-IT', 'pt-BR', 'nl-NL', 'ja-JP', 'zh-CN', 'ko-KR'].map((l) => html`<option value=${l} />`)}</datalist>
    ${me.user.role === 'admin' && html`<label class="field">Visibility<select class="input" name="visibility" value=${c.visibility || 'private'}>
      <option value="private">Private — you and people you share with</option><option value="public">Public — in the library for every user</option></select></label>`}
    ${st.error && html`<p class="error">${st.error}</p>`}
    <div class="row"><button class="btn primary" disabled=${st.busy}>${course ? 'Save' : 'Create course'}</button>${onCancel && html`<button type="button" class="btn ghost" onClick=${onCancel}>Cancel</button>`}</div>
  </form>`;
}

// Daily quests with progress. `completed` (quest ids) highlights the ones a session just finished.
export const Quests = ({ quests, completed = [] }) => html`<ul class="quests">${quests.map((q) => html`<li class=${`${q.done ? 'done' : ''} ${completed.includes(q.id) ? 'new' : ''}`}>
  <span class="q-ico"><${Icon} name=${q.done ? 'check' : 'target'} size=${16} /></span>
  <div class="grow"><div class="row between"><span>${q.label}</span><span class="small muted">${q.done ? (completed.includes(q.id) ? `+${QUEST_XP} XP` : 'Done') : `${q.progress} / ${q.goal}`}</span></div>
    <div class="progress thin"><i style=${{ width: `${(q.progress / q.goal) * 100}%` }} /></div></div>
</li>`)}</ul>`;
