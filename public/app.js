import { html, render, useState, useEffect } from '/vendor/htm-preact.js';
import { api, useAsync, prefs, toast, setTheme, currentTheme, Md, Icon } from '/ui.js';
import { parseDelimited } from '/lib.js';
import { Study } from '/study.js';

if ('serviceWorker' in navigator) addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));

function useRoute() {
  const [hash, setHash] = useState(location.hash.slice(1) || '/');
  useEffect(() => {
    const on = () => { setHash(location.hash.slice(1) || '/'); scrollTo(0, 0); };
    addEventListener('hashchange', on);
    return () => removeEventListener('hashchange', on);
  }, []);
  const [path, qs = ''] = hash.split('?');
  return { parts: path.split('/').filter(Boolean), query: Object.fromEntries(new URLSearchParams(qs)) };
}

// Wraps an async submit handler with busy + error state.
function useSubmit(fn) {
  const [state, setState] = useState({ busy: false, error: '' });
  const submit = async (e) => {
    e?.preventDefault();
    setState({ busy: true, error: '' });
    try { await fn(e); setState({ busy: false, error: '' }); } catch (err) { setState({ busy: false, error: err.message }); }
  };
  return [submit, state];
}

const formData = (e) => Object.fromEntries(new FormData(e.target));

// ---------------- Auth ----------------
function AuthShell({ title, subtitle, children }) {
  return html`<div class="auth"><div class="panel col pop" style="gap:16px">
    <div class="logo" style="font-size:18px"><i />Flipp</div>
    <div><h1 style="font-size:22px">${title}</h1>${subtitle && html`<p class="muted small" style="margin-top:4px">${subtitle}</p>`}</div>
    ${children}
  </div></div>`;
}
const SsoButton = ({ me }) => me.oidc && html`<a class="btn lg" href="/api/auth/oidc/login">Continue with ${me.oidc.name}</a>`;

function Setup({ me, onDone }) {
  const [submit, st] = useSubmit(async (e) => { await api('/auth/setup', { method: 'POST', body: formData(e) }); onDone(); });
  return html`<${AuthShell} title="Welcome to Flipp" subtitle="Create the administrator account for this instance.">
    <form class="col" onSubmit=${submit}>
      <label class="field">Name<input class="input" name="name" autocomplete="name" /></label>
      <label class="field">Email<input class="input" name="email" type="email" required autocomplete="email" /></label>
      <label class="field">Password<input class="input" name="password" type="password" minlength="8" required autocomplete="new-password" /></label>
      ${st.error && html`<p class="error">${st.error}</p>`}
      <button class="btn primary lg" disabled=${st.busy}>Create admin account</button>
    </form>
    ${me.oidc && html`<div class="divider">or</div><${SsoButton} me=${me} /><p class="small faint">The first SSO sign-in becomes the administrator.</p>`}
  <//>`;
}

function Login({ me, query, onDone }) {
  const [submit, st] = useSubmit(async (e) => { await api('/auth/login', { method: 'POST', body: formData(e) }); onDone(); });
  return html`<${AuthShell} title="Sign in" subtitle="Pick up where you left off.">
    ${query.error && html`<p class="error">${query.error}</p>`}
    <${SsoButton} me=${me} />
    ${me.oidc && html`<div class="divider">or</div>`}
    <form class="col" onSubmit=${submit}>
      <label class="field">Email<input class="input" name="email" type="email" required autocomplete="username" /></label>
      <label class="field">Password<input class="input" name="password" type="password" required autocomplete="current-password" /></label>
      ${st.error && html`<p class="error">${st.error}</p>`}
      <button class="btn primary lg" disabled=${st.busy}>Sign in</button>
    </form>
    ${me.allowRegistration && html`<p class="small muted">No account? <a href="#/register" style="text-decoration:underline">Create one</a></p>`}
  <//>`;
}

function Register({ me, query, onDone }) {
  const [submit, st] = useSubmit(async (e) => { await api('/auth/register', { method: 'POST', body: { ...formData(e), invite: query.invite } }); onDone(); });
  if (!me.allowRegistration && !query.invite) {
    return html`<${AuthShell} title="Invite only" subtitle="Registration is closed on this instance. Ask an admin for an invite link."><a class="btn" href="#/login">Back to sign in</a><//>`;
  }
  return html`<${AuthShell} title="Create account" subtitle=${query.invite ? "You've been invited to Flipp." : 'Start learning in seconds.'}>
    <form class="col" onSubmit=${submit}>
      <label class="field">Name<input class="input" name="name" autocomplete="name" /></label>
      <label class="field">Email<input class="input" name="email" type="email" required autocomplete="email" /></label>
      <label class="field">Password<input class="input" name="password" type="password" minlength="8" required autocomplete="new-password" /></label>
      ${st.error && html`<p class="error">${st.error}</p>`}
      <button class="btn primary lg" disabled=${st.busy}>Create account</button>
    </form>
    <p class="small muted">Have an account? <a href="#/login" style="text-decoration:underline">Sign in</a></p>
  <//>`;
}

// ---------------- Home ----------------
function Home({ me }) {
  const courses = useAsync(() => api('/courses'));
  const stats = useAsync(() => api('/stats?tz=' + new Date().getTimezoneOffset()));
  const [creating, setCreating] = useState(false);
  const [filter, setFilter] = useState('');
  const h = new Date().getHours();
  const list = (courses.data || []).filter((c) => !filter || `${c.title} ${c.tags}`.toLowerCase().includes(filter.toLowerCase()));
  const s = stats.data;

  return html`<div class="stack">
    <h1>Good ${h < 12 ? 'morning' : h < 18 ? 'afternoon' : 'evening'}, ${me.user.name}</h1>
    <div class="stats">
      <div class="stat"><b>${s ? s.streak : '–'}${s?.streak ? ' 🔥' : ''}</b><span>day streak</span></div>
      <div class="stat"><b>${s ? s.due : '–'}</b><span>cards due</span></div>
      <div class="stat"><b>${s ? s.today : '–'}</b><span>reviews today</span></div>
    </div>
    ${s?.due > 0 && html`<a class="btn primary lg" style="width:100%" href="#/study?mode=learn">Review ${s.due} due card${s.due === 1 ? '' : 's'}</a>`}
    <div class="section">
      <div class="row between" style="margin-bottom:12px">
        <div class="section-title" style="margin:0">Courses</div>
        <div class="row">
          ${(courses.data?.length || 0) > 4 && html`<input class="input" style="width:180px;height:30px;padding:4px 10px" placeholder="Filter…" value=${filter} onInput=${(e) => setFilter(e.target.value)} />`}
          <button class="btn sm" onClick=${() => setCreating(!creating)}>${creating ? 'Cancel' : '+ New course'}</button>
        </div>
      </div>
      ${creating && html`<div style="margin-bottom:12px"><${CourseForm} me=${me} onSaved=${(r) => { location.hash = `#/course/${r.id}`; }} onCancel=${() => setCreating(false)} /></div>`}
      ${courses.error && html`<p class="error">${courses.error.message}</p>`}
      ${courses.data && !courses.data.length && !creating && html`<div class="panel" style="text-align:center;padding:40px">
        <div style="font-size:32px">🗂️</div><h2 style="margin-top:8px">No courses yet</h2>
        <p class="muted" style="margin:6px 0 16px">A course groups related sets, like "Swedish A1" or "System Design".</p>
        <button class="btn primary" onClick=${() => setCreating(true)}>Create your first course</button></div>`}
      <div class="grid">${list.map((c) => html`<a class="tile" href=${`#/course/${c.id}`}>
        <div class="row between"><span class="emoji">${c.icon || '📚'}</span>${c.due_count > 0 && html`<span class="badge">${c.due_count} due</span>`}</div>
        <h3>${c.title}</h3>
        <p class="small muted">${c.set_count} set${c.set_count == 1 ? '' : 's'} · ${c.card_count} cards${c.visibility === 'public' ? ' · Public' : ''}</p>
        ${c.tags && html`<div class="row" style="gap:4px;margin-top:8px">${c.tags.split(',').map((t) => html`<span class="tag">${t}</span>`)}</div>`}
      </a>`)}</div>
    </div>
  </div>`;
}

function CourseForm({ me, course, onSaved, onCancel }) {
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
      <option value="private">Private — only you</option><option value="public">Public — every user on this instance</option></select></label>`}
    ${st.error && html`<p class="error">${st.error}</p>`}
    <div class="row"><button class="btn primary" disabled=${st.busy}>${course ? 'Save' : 'Create course'}</button>${onCancel && html`<button type="button" class="btn ghost" onClick=${onCancel}>Cancel</button>`}</div>
  </form>`;
}

// ---------------- Course ----------------
function Course({ me, id }) {
  const { data: c, error, reload } = useAsync(() => api(`/courses/${id}`), [id]);
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [submitSet, st] = useSubmit(async (e) => {
    const r = await api(`/courses/${id}/sets`, { method: 'POST', body: formData(e) });
    location.hash = `#/set/${r.id}`;
  });
  if (error) return html`<p class="error">${error.message}</p>`;
  if (!c) return null;
  const del = async () => { if (confirm(`Delete "${c.title}" and all its sets and cards?`)) { await api(`/courses/${id}`, { method: 'DELETE' }); location.hash = '#/'; } };
  const due = c.sets.reduce((n, s) => n + Number(s.due_count), 0);
  const total = c.sets.reduce((n, s) => n + Number(s.card_count), 0);

  return html`<div class="stack">
    <a class="small muted" href="#/">← Courses</a>
    ${editing
      ? html`<${CourseForm} me=${me} course=${c} onSaved=${() => { setEditing(false); reload(); }} onCancel=${() => setEditing(false)} />`
      : html`<div class="row" style="align-items:flex-start;gap:16px">
          <div style="font-size:44px;line-height:1">${c.icon || '📚'}</div>
          <div class="grow">
            <h1>${c.title}</h1>
            ${c.description && html`<p class="muted" style="margin-top:4px">${c.description}</p>`}
            <div class="row" style="gap:4px;margin-top:8px">${c.visibility === 'public' && html`<span class="tag">Public</span>`}${c.tags && c.tags.split(',').map((t) => html`<span class="tag">${t}</span>`)}</div>
          </div>
          ${c.canEdit && html`<div class="row"><button class="btn sm" onClick=${() => setEditing(true)}>Edit</button><button class="btn sm ghost danger" onClick=${del}>Delete</button></div>`}
        </div>`}
    ${total > 0 && html`<div class="row">
      <a class="btn primary" href=${`#/study?course=${id}&mode=learn`}>${due ? `Learn · ${due} due` : 'Learn course'}</a>
      <a class="btn" href=${`#/study?course=${id}&mode=flip`}>Flashcards</a>
      <a class="btn" href=${`#/study?course=${id}&mode=write`}>Write</a>
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
        <div class="grow"><h3>${s.title}</h3><p class="small muted">${s.card_count} cards${s.description ? ' · ' + s.description : ''}</p>
          <div class="progress" style="margin-top:10px;max-width:260px" title="Mastered"><i style=${{ width: (s.card_count ? (s.mastered_count / s.card_count) * 100 : 0) + '%' }} /></div></div>
        ${s.due_count > 0 && html`<span class="badge">${s.due_count} due</span>`}
      </a>`)}</div>
    </div>
  </div>`;
}

// ---------------- Set ----------------
function CardEditor({ card, onSave, onCancel }) {
  const [front, setFront] = useState(card?.front || '');
  const [back, setBack] = useState(card?.back || '');
  const [image, setImage] = useState(card?.image || null);
  const [preview, setPreview] = useState(false);
  const [save, st] = useSubmit(async () => {
    await onSave({ front, back, image });
    if (!card) { setFront(''); setBack(''); setImage(null); document.querySelector('.card-editor textarea')?.focus(); }
  });
  const upload = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try { setImage((await api('/uploads', { method: 'POST', file })).url); } catch (err) { toast(err.message); }
  };
  const keys = (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) save(e); };
  return html`<form class="panel col card-editor" onSubmit=${save} onKeyDown=${keys}>
    <div class="row" style="align-items:stretch">
      <label class="field grow" style="min-width:220px">Front · term
        ${preview ? html`<div class="input"><${Md} src=${front} /></div>` : html`<textarea class="input" required value=${front} onInput=${(e) => setFront(e.target.value)} placeholder="Markdown, \`code\`, $LaTeX$" />`}</label>
      <label class="field grow" style="min-width:220px">Back · definition
        ${preview ? html`<div class="input"><${Md} src=${back} /></div>` : html`<textarea class="input" value=${back} onInput=${(e) => setBack(e.target.value)} />`}</label>
    </div>
    ${image && html`<div class="row"><img src=${image} style="max-height:80px;border-radius:8px" alt="" /><button type="button" class="btn sm ghost" onClick=${() => setImage(null)}>Remove image</button></div>`}
    ${st.error && html`<p class="error">${st.error}</p>`}
    <div class="row">
      <button class="btn primary" disabled=${st.busy}>${card ? 'Save' : 'Add card'} <kbd>⌘↵</kbd></button>
      <label class="btn ghost">Image<input type="file" accept="image/png,image/jpeg,image/gif,image/webp" hidden onChange=${upload} /></label>
      <button type="button" class="btn ghost" onClick=${() => setPreview(!preview)}>${preview ? 'Edit' : 'Preview'}</button>
      ${onCancel && html`<button type="button" class="btn ghost" onClick=${onCancel}>Cancel</button>`}
    </div>
  </form>`;
}

function Import({ setId, onDone }) {
  const [text, setText] = useState('');
  const [delim, setDelim] = useState('auto');
  let rows = parseDelimited(text, delim === 'tab' ? '\t' : delim);
  if (rows[0] && rows[0][0].toLowerCase() === 'front' && rows[0][1].toLowerCase() === 'back') rows = rows.slice(1);
  const [submit, st] = useSubmit(async () => {
    await api(`/sets/${setId}/cards`, { method: 'POST', body: { cards: rows.map(([front, back]) => ({ front, back })) } });
    toast(`Imported ${rows.length} cards`);
    onDone();
  });
  return html`<form class="panel col pop" onSubmit=${submit}>
    <p class="small muted">Paste from Quizlet (Export → tab between term and definition, new line between cards), a spreadsheet, or CSV.</p>
    <textarea class="input" rows="8" value=${text} onInput=${(e) => setText(e.target.value)} placeholder=${'hund\tdog\nkatt\tcat'} style="font-family:var(--mono);font-size:13px" />
    <div class="row">
      <select class="input" style="width:auto" value=${delim} onChange=${(e) => setDelim(e.target.value)}>
        <option value="auto">Detect separator</option><option value="tab">Tab</option><option value=",">Comma</option><option value=";">Semicolon</option></select>
      <span class="small muted grow">${rows.length} card${rows.length === 1 ? '' : 's'} detected</span>
      <button class="btn primary" disabled=${!rows.length || st.busy}>Import</button>
    </div>
    ${st.error && html`<p class="error">${st.error}</p>`}
  </form>`;
}

function SetPage({ id }) {
  const { data: s, error, reload } = useAsync(() => api(`/sets/${id}`), [id]);
  const [panel, setPanel] = useState(null); // 'add' | 'import' | 'edit-set'
  const [editing, setEditing] = useState(null);
  const [starredOnly, setStarredOnly] = useState(false);
  if (error) return html`<p class="error">${error.message}</p>`;
  if (!s) return null;
  const canEdit = s.course.canEdit;
  const starredCount = s.cards.filter((c) => c.starred).length;
  const q = `set=${id}${starredOnly ? '&starred=1' : ''}`;
  const star = async (c) => { await api(`/cards/${c.id}/star`, { method: 'POST', body: { starred: !c.starred } }); reload(); };
  const delCard = async (c) => { if (confirm('Delete this card?')) { await api(`/cards/${c.id}`, { method: 'DELETE' }); reload(); } };
  const delSet = async () => { if (confirm(`Delete set "${s.title}"?`)) { await api(`/sets/${id}`, { method: 'DELETE' }); location.hash = `#/course/${s.course_id}`; } };
  const saveSet = async (e) => { e.preventDefault(); await api(`/sets/${id}`, { method: 'PUT', body: Object.fromEntries(new FormData(e.target)) }).catch((err) => toast(err.message)); setPanel(null); reload(); };
  const modes = [['learn', 'Learn', 'Spaced repetition'], ['flip', 'Flashcards', 'Flip & swipe'], ['write', 'Write', 'Type the answer'], ['match', 'Match', 'Beat the clock']];

  return html`<div class="stack">
    <a class="small muted" href=${`#/course/${s.course_id}`}>← ${s.course.icon || '📚'} ${s.course.title}</a>
    ${panel === 'edit-set'
      ? html`<form class="panel col" onSubmit=${saveSet}>
          <label class="field">Title<input class="input" name="title" value=${s.title} required maxlength="120" /></label>
          <label class="field">Description<input class="input" name="description" value=${s.description} /></label>
          <div class="row"><button class="btn primary">Save</button><button type="button" class="btn ghost" onClick=${() => setPanel(null)}>Cancel</button><span class="grow" /><button type="button" class="btn ghost danger" onClick=${delSet}>Delete set</button></div>
        </form>`
      : html`<div class="row between"><div><h1>${s.title}</h1>${s.description && html`<p class="muted">${s.description}</p>`}<p class="small faint">${s.cards.length} cards</p></div>
          ${canEdit && html`<button class="btn sm" onClick=${() => setPanel('edit-set')}>Edit</button>`}</div>`}

    ${s.cards.length > 0 && html`<div>
      <div class="modes">${modes.map(([m, title, sub]) => html`<a class="mode" href=${`#/study?${q}&mode=${m}`}><b>${title}</b><span>${sub}</span></a>`)}</div>
      ${starredCount > 0 && html`<label class="check" style="margin-top:12px"><input type="checkbox" checked=${starredOnly} onChange=${(e) => setStarredOnly(e.target.checked)} /> Study only starred (${starredCount})</label>`}
    </div>`}

    <div class="section">
      <div class="row between" style="margin-bottom:12px">
        <div class="section-title" style="margin:0">Cards</div>
        <div class="row">
          ${s.cards.length > 0 && html`<a class="btn sm ghost" href=${`/api/sets/${id}/export.csv`} download>Export CSV</a>`}
          ${canEdit && html`<button class="btn sm ghost" onClick=${() => setPanel(panel === 'import' ? null : 'import')}>Import</button>
            <button class="btn sm" onClick=${() => setPanel(panel === 'add' ? null : 'add')}>+ Add card</button>`}
        </div>
      </div>
      ${panel === 'import' && html`<div style="margin-bottom:12px"><${Import} setId=${id} onDone=${() => { setPanel(null); reload(); }} /></div>`}
      ${panel === 'add' && html`<div style="margin-bottom:12px"><${CardEditor} onSave=${async (c) => { await api(`/sets/${id}/cards`, { method: 'POST', body: c }); reload(); }} onCancel=${() => setPanel(null)} /></div>`}
      ${!s.cards.length && panel !== 'add' && panel !== 'import' && html`<p class="muted">No cards yet. ${canEdit ? 'Add some or paste a list with Import.' : ''}</p>`}
      ${s.cards.length > 0 && html`<div class="panel" style="padding:0">${s.cards.map((c) => editing === c.id
        ? html`<div style="padding:8px"><${CardEditor} card=${c} onSave=${async (v) => { await api(`/cards/${c.id}`, { method: 'PUT', body: v }); setEditing(null); reload(); }} onCancel=${() => setEditing(null)} /></div>`
        : html`<div class="cardrow">
            <div>${c.image && html`<img src=${c.image} alt="" />`}<${Md} src=${c.front} /></div>
            <${Md} class="back" src=${c.back} />
            <div class="row actions" style="gap:2px;flex-wrap:nowrap">
              <button class="btn ghost icon-btn star ${c.starred ? 'on' : ''}" title="Star" onClick=${() => star(c)}><${Icon} name="star" fill=${!!c.starred} /></button>
              ${canEdit && html`<button class="btn ghost sm" onClick=${() => setEditing(c.id)}>Edit</button><button class="btn ghost sm danger" onClick=${() => delCard(c)}>✕</button>`}
            </div>
          </div>`)}</div>`}
    </div>
  </div>`;
}

// ---------------- Settings & Admin ----------------
function Settings({ me, onLogout }) {
  const [theme, setT] = useState(currentTheme());
  const [sound, setSound] = useState(prefs.get('sound', false));
  const [haptics, setHaptics] = useState(prefs.get('haptics', true));
  const [changePw, st] = useSubmit(async (e) => { await api('/auth/password', { method: 'POST', body: formData(e) }); e.target.reset(); toast('Password updated'); });
  const logout = async () => { await api('/auth/logout', { method: 'POST' }); onLogout(); };
  return html`<div class="stack">
    <h1>Settings</h1>
    <div class="panel col">
      <div class="section-title" style="margin:0">Appearance & feedback</div>
      <label class="field">Theme<select class="input" value=${theme} onChange=${(e) => { setTheme(e.target.value); setT(e.target.value); }}>
        <option value="system">Match system</option><option value="dark">Dark</option><option value="light">Light</option></select></label>
      <label class="check"><input type="checkbox" checked=${sound} onChange=${(e) => { prefs.set('sound', e.target.checked); setSound(e.target.checked); }} /> Sound effects</label>
      <label class="check"><input type="checkbox" checked=${haptics} onChange=${(e) => { prefs.set('haptics', e.target.checked); setHaptics(e.target.checked); }} /> Haptics (where supported)</label>
    </div>
    <div class="panel col">
      <div class="section-title" style="margin:0">Account</div>
      <p>${me.user.name} <span class="muted">· ${me.user.email} · ${me.user.role}</span></p>
      <form class="col" onSubmit=${changePw}>
        <div class="row"><input class="input grow" style="width:auto" name="current" type="password" placeholder="Current password" autocomplete="current-password" />
          <input class="input grow" style="width:auto" name="password" type="password" placeholder="New password (8+)" minlength="8" required autocomplete="new-password" />
          <button class="btn" disabled=${st.busy}>Change password</button></div>
        ${st.error && html`<p class="error">${st.error}</p>`}
      </form>
      <div class="row">${me.user.role === 'admin' && html`<a class="btn" href="#/admin">Admin</a>`}<button class="btn danger" onClick=${logout}>Sign out</button></div>
    </div>
  </div>`;
}

function Admin({ me }) {
  const users = useAsync(() => api('/admin/users'));
  const settings = useAsync(() => api('/admin/settings'));
  const [addUser, st] = useSubmit(async (e) => { await api('/admin/users', { method: 'POST', body: formData(e) }); e.target.reset(); users.reload(); });
  const act = (p) => p.then(() => { users.reload(); settings.reload(); }, (e) => toast(e.message));
  const invite = async () => {
    const { code } = await api('/admin/invites', { method: 'POST' });
    const link = `${location.origin}/#/register?invite=${code}`;
    navigator.clipboard?.writeText(link).then(() => toast('Invite link copied'), () => {});
    settings.reload();
  };
  if (me.user.role !== 'admin') return html`<p class="error">Admins only.</p>`;
  return html`<div class="stack">
    <h1>Admin</h1>
    <div class="panel col">
      <div class="section-title" style="margin:0">Registration</div>
      ${settings.data && html`<label class="check"><input type="checkbox" checked=${settings.data.allowRegistration}
        onChange=${(e) => act(api('/admin/settings', { method: 'PUT', body: { allowRegistration: e.target.checked } }))} /> Allow public sign-ups</label>`}
      <p class="small muted">When off, people can join only with an invite link or via SSO (if configured).</p>
      <div><button class="btn sm" onClick=${invite}>Create invite link</button></div>
      ${settings.data?.invites.length > 0 && html`<div class="scroll-x"><table class="list"><thead><tr><th>Invite</th><th>Status</th><th /></tr></thead><tbody>
        ${settings.data.invites.map((i) => html`<tr><td><code class="small">…/#/register?invite=${i.code}</code></td>
          <td class="small muted">${i.used_by_email ? `used by ${i.used_by_email}` : i.expires_at < Date.now() ? 'expired' : `valid until ${new Date(i.expires_at).toLocaleDateString()}`}</td>
          <td style="text-align:right">${!i.used_by_email && html`<button class="btn ghost sm" onClick=${() => navigator.clipboard?.writeText(`${location.origin}/#/register?invite=${i.code}`).then(() => toast('Copied'))}>Copy</button>`}
            <button class="btn ghost sm danger" onClick=${() => act(api(`/admin/invites/${i.code}`, { method: 'DELETE' }))}>✕</button></td></tr>`)}
      </tbody></table></div>`}
    </div>
    <div class="panel col">
      <div class="section-title" style="margin:0">Users</div>
      <div class="scroll-x"><table class="list"><thead><tr><th>User</th><th>Role</th><th>Courses</th><th /></tr></thead><tbody>
        ${(users.data || []).map((u) => html`<tr>
          <td>${u.name}<div class="small muted">${u.email}${u.sso ? ' · SSO' : ''}</div></td>
          <td>${u.id === me.user.id ? u.role : html`<select class="input" style="width:auto;padding:4px 8px" value=${u.role}
            onChange=${(e) => act(api(`/admin/users/${u.id}`, { method: 'PUT', body: { role: e.target.value } }))}><option value="user">User</option><option value="admin">Admin</option></select>`}</td>
          <td>${u.courses}</td>
          <td style="text-align:right">${u.id !== me.user.id && html`<button class="btn ghost sm danger" onClick=${() => confirm(`Delete ${u.email} and all their data?`) && act(api(`/admin/users/${u.id}`, { method: 'DELETE' }))}>Delete</button>`}</td>
        </tr>`)}
      </tbody></table></div>
      <form class="row" onSubmit=${addUser}>
        <input class="input grow" style="width:auto" name="email" type="email" placeholder="Email" required />
        <input class="input grow" style="width:auto" name="password" type="password" placeholder="Temporary password" minlength="8" required />
        <select class="input" style="width:auto" name="role"><option value="user">User</option><option value="admin">Admin</option></select>
        <button class="btn" disabled=${st.busy}>Add user</button>
      </form>
      ${st.error && html`<p class="error">${st.error}</p>`}
    </div>
  </div>`;
}

// ---------------- Shell ----------------
function Shell({ me, route, children, study }) {
  const top = route.parts[0] || '';
  const [theme, setT] = useState(currentTheme());
  const dark = theme === 'dark' || (theme === 'system' && !matchMedia('(prefers-color-scheme: light)').matches);
  const toggle = () => { const t = dark ? 'light' : 'dark'; setTheme(t); setT(t); };
  useEffect(() => { document.body.classList.toggle('study-page', !!study); }, [study]);
  const link = (href, label, on) => html`<a class="navlink ${on ? 'on' : ''}" href=${href}>${label}</a>`;
  return html`
    <header class="topbar">
      <a class="logo" href="#/"><i />Flipp</a>
      <nav>${link('#/', 'Home', !top || top === 'course' || top === 'set')}${link('#/study?mode=learn', 'Review', top === 'study')}${me.user.role === 'admin' && link('#/admin', 'Admin', top === 'admin')}${link('#/settings', 'Settings', top === 'settings')}</nav>
      <span class="spacer" />
      <button class="btn ghost icon-btn" onClick=${toggle} title="Toggle theme"><${Icon} name=${dark ? 'sun' : 'moon'} /></button>
    </header>
    <main>${children}</main>
    <nav class="bottomnav">
      <a href="#/" class=${!top || top === 'course' || top === 'set' ? 'on' : ''}><${Icon} name="home" />Home</a>
      <a href="#/study?mode=learn" class=${top === 'study' ? 'on' : ''}><${Icon} name="bolt" />Review</a>
      <a href="#/settings" class=${top === 'settings' || top === 'admin' ? 'on' : ''}><${Icon} name="gear" />Settings</a>
    </nav>`;
}

function App() {
  const route = useRoute();
  const [me, setMe] = useState(null);
  const [err, setErr] = useState('');
  const load = () => api('/auth/me').then((m) => { setMe(m); setErr(''); }, (e) => setErr(e.message));
  useEffect(() => { load(); addEventListener('flipp:auth', load); return () => removeEventListener('flipp:auth', load); }, []);

  if (err) return html`<div class="auth"><div class="col" style="align-items:center"><p class="error">${err}</p><button class="btn" onClick=${load}>Retry</button></div></div>`;
  if (!me) return html`<div class="boot">Flipp</div>`;
  const done = () => { location.hash = '#/'; load(); };
  if (me.needsSetup) return html`<${Setup} me=${me} onDone=${done} />`;
  if (!me.user) return route.parts[0] === 'register' ? html`<${Register} me=${me} query=${route.query} onDone=${done} />` : html`<${Login} me=${me} query=${route.query} onDone=${done} />`;

  const [page, id] = route.parts;
  const view =
    page === 'course' ? html`<${Course} key=${id} me=${me} id=${id} />`
    : page === 'set' ? html`<${SetPage} key=${id} id=${id} />`
    : page === 'study' ? html`<${Study} key=${JSON.stringify(route.query)} query=${route.query} />`
    : page === 'settings' ? html`<${Settings} me=${me} onLogout=${() => { location.hash = '#/login'; load(); }} />`
    : page === 'admin' ? html`<${Admin} me=${me} />`
    : html`<${Home} me=${me} />`;
  return html`<${Shell} me=${me} route=${route} study=${page === 'study'}>${view}<//>`;
}

render(html`<${App} />`, document.getElementById('app'));
