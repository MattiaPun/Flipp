// Course page: sets, study entry points, sharing, publishing, personal study settings, clone, export/import.
import { html, useState } from '/vendor/htm-preact.js';
import { api, useAsync, useSubmit, formData, toast, Modal, Icon } from '/ui.js';
import { CourseForm } from '/pages/home.js';
import { TransferButtons, AnkiDialog } from '/pages/transfer.js';

export function Course({ me, id }) {
  const { data: c, error, reload } = useAsync(() => api(`/courses/${id}`), [id]);
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [modal, setModal] = useState(null); // 'share' | 'prefs' | 'anki'
  const [submitSet, st] = useSubmit(async (e) => {
    const r = await api(`/courses/${id}/sets`, { method: 'POST', body: formData(e) });
    location.hash = `#/set/${r.id}`;
  });
  if (error) return html`<p class="error">${error.message}</p>`;
  if (!c) return null;
  const run = (p, msg) => p.then(() => { reload(); if (msg) toast(msg); }, (e) => toast(e.message));
  const del = async () => { if (confirm(`Delete "${c.title}" and all its sets and cards?`)) { await api(`/courses/${id}`, { method: 'DELETE' }); location.hash = '#/'; } };
  const clone = async () => { try { const r = await api(`/courses/${id}/clone`, { method: 'POST' }); toast('Copied into your courses'); location.hash = `#/course/${r.id}`; } catch (e) { toast(e.message); } };
  const publish = (on) => run(api(`/courses/${id}/publish`, { method: 'POST', body: { publish: on } }).then((r) => toast(r.status === 'pending' ? 'Sent to an admin for review' : r.status === 'approved' ? 'Published to the library' : 'Removed from the library')));
  const due = c.sets.reduce((n, s) => n + Number(s.due_count), 0);
  const total = c.sets.reduce((n, s) => n + Number(s.card_count), 0);
  const isPublicGuest = c.role === 'public';

  return html`<div class="stack">
    <a class="small muted" href="#/">← Courses</a>
    ${editing
      ? html`<${CourseForm} me=${me} course=${c} onSaved=${() => { setEditing(false); reload(); }} onCancel=${() => setEditing(false)} />`
      : html`<div class="row" style="align-items:flex-start;gap:16px">
          <div style="font-size:44px;line-height:1">${c.icon || '📚'}</div>
          <div class="grow">
            <h1>${c.title}</h1>
            ${c.description && html`<p class="muted" style="margin-top:4px">${c.description}</p>`}
            <div class="row" style="gap:4px;margin-top:8px">
              ${c.visibility === 'public' && html`<span class="tag">Public</span>`}
              ${c.publish_status === 'pending' && html`<span class="tag">Waiting for review</span>`}
              ${c.publish_status === 'rejected' && html`<span class="tag">Publication declined</span>`}
              ${c.role !== 'owner' && html`<span class="tag">${c.role === 'admin' ? 'admin access' : c.role === 'group' ? 'via group' : c.role === 'public' ? `by ${c.owner_name}` : `shared · ${c.role}`}</span>`}
              ${c.tags && c.tags.split(',').map((t) => html`<span class="tag">${t}</span>`)}
            </div>
          </div>
          <details class="menu"><summary class="btn sm">⋯</summary><div class="menu-list right">
            ${c.canEdit && html`<button onClick=${() => setEditing(true)}>Edit details</button>`}
            <button onClick=${() => setModal('prefs')}>Study settings</button>
            ${c.canManage && html`<button onClick=${() => setModal('share')}>Share…</button>`}
            ${c.canManage && c.visibility !== 'public' && c.publish_status !== 'pending' && html`<button onClick=${() => publish(true)}>${me.user.role === 'admin' ? 'Publish to library' : 'Request publication'}</button>`}
            ${c.canManage && (c.visibility === 'public' || c.publish_status === 'pending') && html`<button onClick=${() => publish(false)}>${c.visibility === 'public' ? 'Remove from library' : 'Cancel publication request'}</button>`}
            ${isPublicGuest && html`<button onClick=${() => run(api(`/courses/${id}/save`, { method: 'POST', body: { saved: !c.saved } }), c.saved ? 'Removed from your courses' : 'Added to your courses')}>${c.saved ? 'Remove from my courses' : 'Add to my courses'}</button>`}
            ${['viewer', 'editor'].includes(c.role) && html`<button onClick=${() => { if (confirm('Leave this shared course?')) api(`/courses/${id}/members/me`, { method: 'DELETE' }).then(() => { location.hash = '#/'; }, (e) => toast(e.message)); }}>Leave course</button>`}
            <button onClick=${clone}>Make a copy</button>
            <${TransferButtons} course=${c} onAnki=${() => setModal('anki')} />
            ${c.canManage && html`<button class="danger" onClick=${del}>Delete course</button>`}
          </div></details>
        </div>`}
    ${total > 0 && html`<div class="row">
      <a class="btn primary" href=${`#/study?course=${id}&mode=learn`}>${due ? `Learn · ${due} due` : 'Learn course'}</a>
      <a class="btn" href=${`#/study?course=${id}&mode=flip`}>Flashcards</a>
      <a class="btn" href=${`#/study?course=${id}&mode=write`}>Write</a>
      <a class="btn" href=${`#/study?course=${id}&mode=test`}>Test</a>
      <a class="btn ghost" href=${`#/study?course=${id}&mode=cram`}>Cram</a>
    </div>`}
    <div class="section">
      <div class="row between" style="margin-bottom:12px"><div class="section-title" style="margin:0">Sets</div>
        ${c.canEdit && html`<button class="btn sm" onClick=${() => setAdding(!adding)}>${adding ? 'Cancel' : '+ New set'}</button>`}</div>
      ${adding && html`<form class="panel col pop" style="margin-bottom:12px" onSubmit=${submitSet}>
        <label class="field">Title<input class="input" name="title" required maxlength="120" placeholder="Common verbs" autofocus /></label>
        <label class="field">Description<input class="input" name="description" maxlength="2000" /></label>
        ${st.error && html`<p class="error">${st.error}</p>`}
        <div><button class="btn primary" disabled=${st.busy}>Create set</button></div></form>`}
      ${!c.sets.length && !adding && html`<p class="muted">No sets yet.</p>`}
      <div class="col" style="gap:8px">${c.sets.map((s) => html`<a class="tile row between" href=${`#/set/${s.id}`}>
        <div class="grow"><h3>${s.title}</h3><p class="small muted">${s.card_count} cards${s.reverse ? ' · both directions' : ''}${s.description ? ' · ' + s.description : ''}</p>
          <div class="progress" style="margin-top:10px;max-width:260px" title=${`${s.mastered_count} of ${s.card_count} mastered`}><i style=${{ width: (s.card_count ? (s.mastered_count / s.card_count) * 100 : 0) + '%' }} /></div></div>
        ${s.due_count > 0 && html`<span class="badge">${s.due_count} due</span>`}
      </a>`)}</div>
    </div>
    ${modal === 'share' && html`<${ShareDialog} course=${c} onClose=${() => setModal(null)} />`}
    ${modal === 'anki' && html`<${AnkiDialog} course=${c} onClose=${() => setModal(null)} onImported=${reload} />`}
    ${modal === 'prefs' && html`<${PrefsDialog} course=${c} onClose=${() => { setModal(null); reload(); }} />`}
  </div>`;
}

function ShareDialog({ course, onClose }) {
  const members = useAsync(() => api(`/courses/${course.id}/members`));
  const [add, st] = useSubmit(async (e) => { await api(`/courses/${course.id}/members`, { method: 'POST', body: formData(e) }); e.target.reset(); members.reload(); toast('Shared'); });
  const change = (u, role) => api(`/courses/${course.id}/members`, { method: 'POST', body: { email: u.email, role } }).then(members.reload, (e) => toast(e.message));
  const remove = (u) => api(`/courses/${course.id}/members/${u.id}`, { method: 'DELETE' }).then(members.reload, (e) => toast(e.message));
  return html`<${Modal} title="Share course" onClose=${onClose}>
    <div class="col">
      <form class="row" onSubmit=${add}>
        <input class="input grow" style="width:auto" name="email" type="email" required placeholder="Their email address" />
        <select class="input" style="width:auto" name="role"><option value="viewer">Can study</option><option value="editor">Can edit</option></select>
        <button class="btn primary" disabled=${st.busy}>Share</button>
      </form>
      ${st.error && html`<p class="error">${st.error}</p>`}
      <p class="small faint">People need an account on this instance. Viewers can study; editors can also add and change sets and cards. Only you can delete the course or share it.</p>
      ${(members.data || []).length > 0 && html`<table class="list"><tbody>${members.data.map((u) => html`<tr>
        <td>${u.name}<div class="small muted">${u.email}</div></td>
        <td><select class="input compact" value=${u.role} onChange=${(e) => change(u, e.target.value)} aria-label="Access"><option value="viewer">Can study</option><option value="editor">Can edit</option></select></td>
        <td style="text-align:right"><button class="btn ghost sm danger" onClick=${() => remove(u)}>Remove</button></td></tr>`)}</tbody></table>`}
    </div>
  <//>`;
}

function PrefsDialog({ course, onClose }) {
  const p = course.prefs;
  const [save, st] = useSubmit(async (e) => {
    const f = formData(e);
    const steps = (s) => s.split(/[\s,]+/).map(Number).filter((n) => n > 0);
    await api(`/courses/${course.id}/prefs`, { method: 'PUT', body: {
      retention: Number(f.retention) / 100, newPerDay: Number(f.newPerDay), reviewsPerDay: Number(f.reviewsPerDay),
      steps: steps(f.steps), relearnSteps: steps(f.relearnSteps), leechThreshold: Number(f.leechThreshold), leechAction: f.leechAction,
    } });
    toast('Study settings saved');
    onClose();
  });
  return html`<${Modal} title="Study settings" onClose=${onClose}>
    <form class="col" onSubmit=${save}>
      <p class="small muted">Personal to you, for this course only.</p>
      <label class="field">Target retention: how often you want to remember a card when it comes due
        <div class="row"><input class="grow" type="range" name="retention" min="70" max="99" value=${Math.round(p.retention * 100)} onInput=${(e) => { e.target.nextElementSibling.textContent = e.target.value + '%'; }} /><span class="mono">${Math.round(p.retention * 100)}%</span></div>
        <span class="small faint">Higher means more reviews. 85–92% suits most people.</span></label>
      <div class="row">
        <label class="field grow">New cards per day<input class="input" type="number" name="newPerDay" min="0" max="9999" value=${p.newPerDay} /></label>
        <label class="field grow">Max reviews per day<input class="input" type="number" name="reviewsPerDay" min="0" max="99999" value=${p.reviewsPerDay} /></label>
      </div>
      <div class="row">
        <label class="field grow">Learning steps (minutes)<input class="input" name="steps" value=${p.steps.join(' ')} placeholder="1 10" /></label>
        <label class="field grow">Relearning steps<input class="input" name="relearnSteps" value=${p.relearnSteps.join(' ')} placeholder="10" /></label>
      </div>
      <div class="row">
        <label class="field grow">Leech after this many lapses<input class="input" type="number" name="leechThreshold" min="2" max="99" value=${p.leechThreshold} /></label>
        <label class="field grow">When a card becomes a leech<select class="input" name="leechAction" value=${p.leechAction}><option value="suspend">Suspend it</option><option value="tag">Only flag it</option></select></label>
      </div>
      ${st.error && html`<p class="error">${st.error}</p>`}
      <button class="btn primary" disabled=${st.busy}>Save</button>
    </form>
  <//>`;
}

export { Icon };
