// Home: greeting, streak/due/goal, courses; plus the course create/edit form.
import { html, useState } from '/vendor/htm-preact.js';
import { api, useAsync, useSubmit, formData, Icon, Mascot } from '/ui.js';
import { ImportCourseButton } from '/pages/transfer.js';

export function Home({ me }) {
  const courses = useAsync(() => api('/courses'));
  const stats = useAsync(() => api('/stats'));
  const [creating, setCreating] = useState(false);
  const [filter, setFilter] = useState('');
  const h = new Date().getHours();
  const list = (courses.data || []).filter((c) => !filter || `${c.title} ${c.tags}`.toLowerCase().includes(filter.toLowerCase()));
  const s = stats.data;
  const goalPct = s?.goal ? Math.min(100, Math.round((s.today / s.goal) * 100)) : null;

  return html`<div class="stack">
    <div class="hello">
      <${Mascot} mood=${s && !s.due && s.today ? 'cheer' : 'happy'} size=${64} class="wiggle" />
      <div><h1>Good ${h < 12 ? 'morning' : h < 18 ? 'afternoon' : 'evening'}, ${me.user.name.split(' ')[0]}!</h1>
        <p>${!s ? '' : s.due ? "Your cards miss you. Let's go!" : s.today ? 'All caught up. Brilliant work today ✨' : 'Ready to learn something new?'}</p></div>
    </div>
    <div class="stats">
      <div class="stat flame"><b><span class="ico">${s?.streak ? '🔥' : '🪵'}</span>${s ? s.streak : '–'}</b><span>day streak</span></div>
      <div class="stat"><b><span class="ico">🃏</span>${s ? s.due : '–'}</b><span>cards due</span></div>
      <div class="stat good"><b><span class="ico">⚡</span>${s ? s.today : '–'}${s?.goal ? html`<small class="muted"> / ${s.goal}</small>` : ''}</b><span>reviews today</span>
        ${goalPct !== null && html`<div class="progress thin" style="margin-top:8px"><i style=${{ width: goalPct + '%' }} /></div>`}</div>
    </div>
    ${s?.due > 0 && html`<a class="cta pop" href="#/study?mode=learn"><span style="font-size:34px">🧠</span>
      <div><b>${s.due} card${s.due === 1 ? '' : 's'} ready for review</b><span>A few minutes keeps them fresh</span></div><span class="go">Start</span></a>`}
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
          ${(courses.data?.length || 0) > 4 && html`<input class="input compact" style="width:180px" placeholder="Filter…" value=${filter} onInput=${(e) => setFilter(e.target.value)} aria-label="Filter courses" />`}
          <${ImportCourseButton} />
          <button class="btn sm" onClick=${() => setCreating(!creating)}>${creating ? 'Cancel' : '+ New course'}</button>
        </div>
      </div>
      ${creating && html`<div style="margin-bottom:12px"><${CourseForm} me=${me} onSaved=${(r) => { location.hash = `#/course/${r.id}`; }} onCancel=${() => setCreating(false)} /></div>`}
      ${courses.error && html`<p class="error">${courses.error.message}</p>`}
      ${courses.data && !courses.data.length && !creating && html`<div class="panel empty">
        <${Mascot} mood="happy" size=${84} /><h2 style="margin-top:8px">No courses yet</h2>
        <p class="muted" style="margin:6px 0 16px">A course groups related sets, like "Swedish A1" or "System Design". Create one, or pick one from the library.</p>
        <div class="row" style="justify-content:center"><button class="btn primary" onClick=${() => setCreating(true)}>Create a course</button><a class="btn" href="#/library">Browse the library</a></div></div>`}
      <div class="grid">${list.map((c) => html`<${CourseTile} c=${c} />`)}</div>
    </div>
  </div>`;
}

// Stable, well-spread hue per course (golden angle) so every tile gets its own color.
const hue = (id) => Math.round((Number(id) * 137.508) % 360);
export const CourseTile = ({ c, extra }) => html`<a class="tile" href=${`#/course/${c.id}`} style=${{ '--hue': hue(c.id) }}>
  <div class="row between"><span class="emoji">${c.icon || '📚'}</span>${c.due_count > 0 && html`<span class="badge">${c.due_count} due</span>`}${c.featured ? html`<span class="tag">★ Featured</span>` : ''}</div>
  <h3>${c.title}</h3>
  <p class="small muted">${c.set_count} set${c.set_count == 1 ? '' : 's'} · ${c.card_count} cards${c.visibility === 'public' ? ' · Public' : ''}${!c.owned && c.owner_name ? ` · by ${c.owner_name}` : ''}${c.member_role ? ` · shared (${c.member_role})` : ''}</p>
  ${c.tags && html`<div class="row" style="gap:4px;margin-top:8px">${c.tags.split(',').map((t) => html`<span class="tag">${t}</span>`)}</div>`}
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
