// Groups / classes: list & join, group page with assignments, members, courses, teacher insights and weekly challenge.
import { html, useState, useEffect } from '/vendor/htm-preact.js';
import { api, useAsync, useSubmit, formData, toast, Modal, Md, fmtDate, timeAgo } from '/ui.js';
import { sides } from '/lib.js';

export function Groups({ me }) {
  const g = useAsync(() => api('/groups'));
  const [creating, setCreating] = useState(false);
  const [create, st] = useSubmit(async (e) => { const r = await api('/groups', { method: 'POST', body: formData(e) }); location.hash = `#/group/${r.id}`; });
  const [join, js] = useSubmit(async (e) => {
    const raw = formData(e).code.trim();
    const code = raw.includes('/join/') ? raw.split('/join/')[1] : raw;
    const r = await api('/groups/join', { method: 'POST', body: { code } });
    location.hash = `#/group/${r.id}`;
  });
  const d = g.data;
  return html`<div class="stack">
    <div class="row between"><h1>Groups</h1>${d?.canCreate && html`<button class="btn sm" onClick=${() => setCreating(true)}>+ New group</button>`}</div>
    <p class="muted">Study together: a teacher assigns courses and deadlines, everyone tracks progress and competes in a weekly challenge.</p>
    ${d && !d.groups.length && html`<div class="panel empty"><div style="font-size:32px">👥</div><p class="muted">You're not in any group yet.${d.canCreate ? ' Create one, or join with an invite link.' : ' Ask your teacher for an invite link.'}</p></div>`}
    <div class="col" style="gap:8px">${(d?.groups || []).map((x) => html`<a class="tile row between" href=${`#/group/${x.id}`}>
      <div><h3>${x.name}</h3><p class="small muted">${x.members} member${x.members == 1 ? '' : 's'}${x.role === 'teacher' ? ' · you teach' : ''}${x.description ? ' · ' + x.description : ''}</p></div>
      ${x.open_assignments > 0 && html`<span class="badge">${x.open_assignments} open</span>`}</a>`)}</div>
    <form class="panel row" onSubmit=${join}>
      <input class="input grow" style="width:auto" name="code" required placeholder="Invite code or link" aria-label="Invite code or link" />
      <button class="btn" disabled=${js.busy}>Join group</button>
    </form>
    ${js.error && html`<p class="error">${js.error}</p>`}
    ${me.user.role === 'admin' && d?.all.length > 0 && html`<div><div class="section-title">Other groups (admin)</div>
      <div class="col" style="gap:6px">${d.all.map((x) => html`<a class="tile" href=${`#/group/${x.id}`}>${x.name} <span class="small muted">· ${x.members} members</span></a>`)}</div></div>`}
    ${creating && html`<${Modal} title="New group" onClose=${() => setCreating(false)}>
      <form class="col" onSubmit=${create}>
        <label class="field">Name<input class="input" name="name" required maxlength="80" placeholder="Swedish evening class" autofocus /></label>
        <label class="field">Description<input class="input" name="description" maxlength="1000" /></label>
        ${st.error && html`<p class="error">${st.error}</p>`}
        <button class="btn primary" disabled=${st.busy}>Create</button>
      </form>
    <//>`}
  </div>`;
}

export function JoinGroup({ code }) {
  const [err, setErr] = useState('');
  useEffect(() => {
    api('/groups/join', { method: 'POST', body: { code } }).then((r) => { toast(`Joined ${r.name}`); location.hash = `#/group/${r.id}`; }, (e) => setErr(e.message));
  }, []);
  return html`<div class="stack">${err ? html`<p class="error">${err}</p><a class="btn" href="#/groups">Back to groups</a>` : html`<p class="faint">Joining…</p>`}</div>`;
}

export function Group({ id, me }) {
  const g = useAsync(() => api(`/groups/${id}`), [id]);
  const [tab, setTab] = useState('assignments');
  const d = g.data;
  if (g.error) return html`<p class="error">${g.error.message}</p>`;
  if (!d) return null;
  const tabs = [['assignments', 'Assignments'], ['challenge', 'Weekly challenge'], ['courses', 'Courses'], ['members', 'Members'], ...(d.teacher ? [['insights', 'Insights']] : [])];
  return html`<div class="stack">
    <a class="small muted" href="#/groups">← Groups</a>
    <div class="row between"><div><h1>${d.name}</h1>${d.description && html`<p class="muted">${d.description}</p>`}</div>
      ${d.teacher ? html`<${GroupMenu} g=${d} reload=${g.reload} />` : html`<button class="btn sm ghost" onClick=${async () => { if (confirm('Leave this group?')) { await api(`/groups/${id}/members/me`, { method: 'DELETE' }).catch((e) => toast(e.message)); location.hash = '#/groups'; } }}>Leave</button>`}</div>
    ${!d.teacher && html`<p class="small faint">Your group's teachers can see your progress on the courses assigned here — nothing else.</p>`}
    <nav class="tabs">${tabs.map(([k, l]) => html`<button class="tab ${tab === k ? 'on' : ''}" onClick=${() => setTab(k)}>${l}</button>`)}</nav>
    ${tab === 'assignments' && html`<${Assignments} g=${d} reload=${g.reload} />`}
    ${tab === 'challenge' && html`<${Challenge} id=${id} />`}
    ${tab === 'courses' && html`<${Courses} g=${d} reload=${g.reload} />`}
    ${tab === 'members' && html`<${Members} g=${d} me=${me} reload=${g.reload} />`}
    ${tab === 'insights' && html`<${Insights} id=${id} />`}
  </div>`;
}

function GroupMenu({ g, reload }) {
  const link = `${location.origin}/#/join/${g.invite_code}`;
  const del = async () => { if (confirm(`Delete "${g.name}"? Members keep their own progress.`)) { await api(`/groups/${g.id}`, { method: 'DELETE' }).catch((e) => toast(e.message)); location.hash = '#/groups'; } };
  const rename = async () => { const n = prompt('Group name', g.name); if (n) { await api(`/groups/${g.id}`, { method: 'PUT', body: { name: n, description: g.description } }).catch((e) => toast(e.message)); reload(); } };
  const reset = async () => { if (confirm('Reset the invite link? The old one stops working.')) { await api(`/groups/${g.id}/code`, { method: 'POST' }); reload(); toast('New invite link created'); } };
  return html`<div class="row">
    <button class="btn sm" onClick=${() => navigator.clipboard?.writeText(link).then(() => toast('Invite link copied'), () => prompt('Invite link', link))}>Copy invite link</button>
    <details class="menu"><summary class="btn sm">⋯</summary><div class="menu-list right">
      <button onClick=${rename}>Rename</button><button onClick=${reset}>Reset invite link</button><button class="danger" onClick=${del}>Delete group</button>
    </div></details>
  </div>`;
}

const Bar = ({ pct }) => html`<div class="progress" style="min-width:80px" role="progressbar" aria-valuenow=${pct} aria-valuemin="0" aria-valuemax="100"><i style=${{ width: pct + '%' }} /></div>`;

function Assignments({ g, reload }) {
  const [adding, setAdding] = useState(false);
  const [courseId, setCourseId] = useState(g.courses[0]?.id || '');
  const sets = useAsync(() => (courseId ? api(`/courses/${courseId}`).then((c) => c.sets) : Promise.resolve([])), [courseId]);
  const [add, st] = useSubmit(async (e) => {
    const f = formData(e);
    await api(`/groups/${g.id}/assignments`, { method: 'POST', body: { title: f.title, courseId: Number(courseId), setId: f.setId ? Number(f.setId) : null, goal: f.goal, dueAt: f.due ? new Date(f.due + 'T23:59:59').getTime() : null } });
    setAdding(false); reload();
  });
  const remove = async (a) => { if (confirm(`Delete assignment "${a.title}"?`)) { await api(`/groups/${g.id}/assignments/${a.id}`, { method: 'DELETE' }).catch((e) => toast(e.message)); reload(); } };
  const memberName = new Map(g.members.map((m) => [m.id, m.name]));
  return html`<div class="col">
    ${g.teacher && html`<div><button class="btn sm" onClick=${() => setAdding(true)} disabled=${!g.courses.length}>+ New assignment</button>${!g.courses.length && html`<span class="small faint"> Add a course to the group first.</span>`}</div>`}
    ${!g.assignments.length && html`<p class="muted">No assignments yet.</p>`}
    ${g.assignments.map((a) => {
      const overdue = a.due_at && a.due_at < Date.now();
      const href = `#/study?${a.set_id ? `set=${a.set_id}` : `course=${a.course_id}`}&mode=learn`;
      return html`<div class="panel col">
        <div class="row between"><div><b>${a.title}</b><div class="small muted">${a.icon} ${a.course_title}${a.set_title ? ` · ${a.set_title}` : ''} · ${a.goal === 'master' ? 'master every card' : 'study every card'} · ${a.total} cards</div></div>
          <div class="row">${a.due_at && html`<span class="tag ${overdue ? 'bad' : ''}">${overdue ? 'was due' : 'due'} ${fmtDate(a.due_at)}</span>`}
            ${g.teacher && html`<button class="btn ghost sm danger" onClick=${() => remove(a)}>Delete</button>`}</div></div>
        <div class="row" style="flex-wrap:nowrap"><span class="small" style="width:70px">You: ${a.mine}%</span><div class="grow"><${Bar} pct=${a.mine} /></div><a class="btn sm primary" href=${href}>Study</a></div>
        ${g.teacher && a.students?.length > 0 && html`<details><summary class="small muted">${a.done} of ${a.students.length} students done</summary>
          <table class="list small"><tbody>${[...a.students].sort((x, y) => x.pct - y.pct).map((s) => html`<tr><td>${memberName.get(s.id)}</td><td style="width:50%"><${Bar} pct=${s.pct} /></td><td>${s.pct}%</td></tr>`)}</tbody></table></details>`}
      </div>`;
    })}
    ${adding && html`<${Modal} title="New assignment" onClose=${() => setAdding(false)}>
      <form class="col" onSubmit=${add}>
        <label class="field">Title<input class="input" name="title" required maxlength="120" placeholder="Week 3 vocabulary" autofocus /></label>
        <label class="field">Course<select class="input" value=${courseId} onChange=${(e) => setCourseId(e.target.value)}>${g.courses.map((c) => html`<option value=${c.id}>${c.icon} ${c.title}</option>`)}</select></label>
        <label class="field">Set<select class="input" name="setId"><option value="">Whole course</option>${(sets.data || []).map((s) => html`<option value=${s.id}>${s.title}</option>`)}</select></label>
        <label class="field">Goal<select class="input" name="goal"><option value="study">Study every card at least once</option><option value="master">Master every card (stable for 3+ weeks)</option></select></label>
        <label class="field">Due date (optional)<input class="input" type="date" name="due" /></label>
        ${st.error && html`<p class="error">${st.error}</p>`}
        <button class="btn primary" disabled=${st.busy}>Create assignment</button>
      </form>
    <//>`}
  </div>`;
}

function Courses({ g, reload }) {
  const mine = useAsync(() => (g.teacher ? api('/courses') : Promise.resolve([])));
  const add = async (e) => { const cid = e.target.value; e.target.value = ''; if (!cid) return; try { await api(`/groups/${g.id}/courses`, { method: 'POST', body: { courseId: Number(cid) } }); reload(); toast('Course added'); } catch (err) { toast(err.message); } };
  const remove = async (c) => { if (confirm(`Remove "${c.title}" from the group? Its assignments are deleted too.`)) { await api(`/groups/${g.id}/courses/${c.id}`, { method: 'DELETE' }).catch((e) => toast(e.message)); reload(); } };
  const available = (mine.data || []).filter((c) => (c.owned || c.visibility === 'public') && !g.courses.some((x) => x.id === c.id));
  return html`<div class="col">
    ${g.teacher && html`<select class="input" style="max-width:360px" onChange=${add}><option value="">+ Add one of your courses…</option>${available.map((c) => html`<option value=${c.id}>${c.icon || '📚'} ${c.title}</option>`)}</select>
      <p class="small faint">Every member can study assigned courses, even private ones.</p>`}
    ${!g.courses.length && html`<p class="muted">No courses yet.</p>`}
    ${g.courses.map((c) => html`<div class="panel row between"><a href=${`#/course/${c.id}`}><b>${c.icon || '📚'} ${c.title}</b> <span class="small muted">· ${c.card_count} cards</span></a>
      ${g.teacher && html`<button class="btn ghost sm danger" onClick=${() => remove(c)}>Remove</button>`}</div>`)}
  </div>`;
}

function Members({ g, me, reload }) {
  const [add, st] = useSubmit(async (e) => { await api(`/groups/${g.id}/members`, { method: 'POST', body: formData(e) }); e.target.reset(); reload(); toast('Added'); });
  const remove = async (m) => { if (confirm(`Remove ${m.name} from the group?`)) { await api(`/groups/${g.id}/members/${m.id}`, { method: 'DELETE' }).catch((e) => toast(e.message)); reload(); } };
  return html`<div class="col">
    ${g.teacher && html`<form class="row" onSubmit=${add}>
      <input class="input grow" style="width:auto" name="email" type="email" required placeholder="Add by email" />
      <select class="input" style="width:auto" name="role"><option value="member">Student</option><option value="teacher">Teacher</option></select>
      <button class="btn" disabled=${st.busy}>Add</button></form>${st.error && html`<p class="error">${st.error}</p>`}`}
    <div class="panel" style="padding:0"><table class="list"><tbody>${g.members.map((m) => html`<tr>
      <td>${m.name}${m.id === me.user.id ? html` <span class="tag">you</span>` : ''}${m.email && html`<div class="small muted">${m.email}</div>`}</td>
      <td class="small">${m.role === 'teacher' ? 'Teacher' : 'Student'}</td>
      ${g.teacher && html`<td class="small muted">${m.last_review ? `active ${timeAgo(m.last_review)}` : 'not started'}</td>`}
      <td style="text-align:right">${g.teacher && m.id !== me.user.id && html`<button class="btn ghost sm danger" onClick=${() => remove(m)}>Remove</button>`}</td></tr>`)}</tbody></table></div>
  </div>`;
}

function Insights({ id }) {
  const { data: d, error } = useAsync(() => api(`/groups/${id}/insights`), [id]);
  if (error) return html`<p class="error">${error.message}</p>`;
  if (!d) return null;
  if (!d.students.length) return html`<p class="muted">Insights appear once students study the group's courses.</p>`;
  return html`<div class="col">
    <div class="panel" style="padding:0"><table class="list"><thead><tr><th>Student</th><th>Reviews (7 days)</th><th>Accuracy</th><th>Last studied</th></tr></thead><tbody>
      ${[...d.students].sort((a, b) => a.reviews7d - b.reviews7d).map((s) => html`<tr><td>${s.name}</td><td>${s.reviews7d}</td>
        <td>${s.accuracy7d == null ? '–' : `${Math.round(s.accuracy7d * 100)}%`}</td><td class="small muted">${s.last ? timeAgo(s.last) : 'never'}</td></tr>`)}
    </tbody></table></div>
    ${d.struggling.length > 0 && html`<div><div class="section-title">Cards the class struggles with</div>
      <div class="panel" style="padding:0">${d.struggling.map((c) => { const s = sides(c, c.type === 'cloze' ? 1 : 0); return html`<a class="cardrow" href=${`#/set/${c.set_id}`}>
        <${Md} src=${s.prompt} /><${Md} class="back" src=${s.answer} />
        <span class="small" style="white-space:nowrap;color:var(--bad)">${Math.round(c.failRate * 100)}% missed<div class="faint">${c.learners} students</div></span></a>`; })}</div></div>`}
  </div>`;
}

function Challenge({ id }) {
  const { data: d, error } = useAsync(() => api(`/groups/${id}/leaderboard`), [id]);
  if (error) return html`<p class="error">${error.message}</p>`;
  if (!d) return null;
  const medals = ['🥇', '🥈', '🥉'];
  return html`<div class="col">
    <p class="small muted">Most reviews this week (${fmtDate(d.weekStart)} – ${fmtDate(d.weekEnd - 1)}, ${d.timezone}). Resets every Monday.</p>
    <div class="panel" style="padding:0"><table class="list"><tbody>${d.members.map((m, i) => html`<tr style=${m.me ? 'font-weight:600' : ''}>
      <td style="width:40px">${m.reviews ? medals[i] || i + 1 : '–'}</td><td>${m.name}${m.me ? ' (you)' : ''}</td>
      <td class="small muted">${m.streak ? `🔥 ${m.streak}` : ''}</td><td style="text-align:right">${m.reviews} reviews</td></tr>`)}</tbody></table></div>
  </div>`;
}
