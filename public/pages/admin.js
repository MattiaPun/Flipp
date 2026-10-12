// Admin console: overview, users & roles, access settings & invites, storage, backups, audit log.
import { html, useState } from '/vendor/htm-preact.js';
import { api, useAsync, useSubmit, formData, toast, Modal, fmtBytes, fmtDate, fmtDateTime, timeAgo } from '/ui.js';
import { Backups } from '/pages/backups.js';

const TABS = [['overview', 'Overview'], ['users', 'Users'], ['access', 'Access'], ['storage', 'Storage'], ['backups', 'Backups'], ['audit', 'Audit log']];

export function Admin({ me, query }) {
  const tab = TABS.some(([k]) => k === query.tab) ? query.tab : 'overview';
  if (me.user.role !== 'admin') return html`<p class="error">Admins only.</p>`;
  return html`<div class="stack">
    <h1>Admin</h1>
    <nav class="tabs" role="tablist">${TABS.map(([k, label]) => html`<a role="tab" aria-selected=${tab === k} class="tab ${tab === k ? 'on' : ''}" href=${`#/admin?tab=${k}`}>${label}</a>`)}</nav>
    ${tab === 'overview' && html`<${Overview} />`}
    ${tab === 'users' && html`<${Users} me=${me} />`}
    ${tab === 'access' && html`<${Access} me=${me} />`}
    ${tab === 'storage' && html`<${Storage} />`}
    ${tab === 'backups' && html`<${Backups} />`}
    ${tab === 'audit' && html`<${Audit} />`}
  </div>`;
}

function Overview() {
  const { data: o, error } = useAsync(() => api('/admin/overview'));
  if (error) return html`<p class="error">${error.message}</p>`;
  if (!o) return null;
  const stat = (n, label) => html`<div class="stat"><b>${n}</b><span>${label}</span></div>`;
  return html`<div class="col">
    <div class="stats four">${stat(o.users, 'users')}${stat(o.courses, 'courses')}${stat(o.cards, 'cards')}${stat(o.reviews7d, 'reviews (7 days)')}</div>
    <div class="panel col small">
      <div class="row between"><span class="muted">Database</span><span>${o.database}${o.dbBytes ? ` · ${fmtBytes(o.dbBytes)}` : ''}</span></div>
      <div class="row between"><span class="muted">Uploads</span><span>${fmtBytes(o.storageBytes)}</span></div>
      <div class="row between"><span class="muted">Email (SMTP)</span><span>${o.mail ? 'configured' : 'not configured'}</span></div>
      <div class="row between"><span class="muted">Total reviews</span><span>${o.reviews}</span></div>
    </div>
  </div>`;
}

function Users({ me }) {
  const users = useAsync(() => api('/admin/users'));
  const [adding, setAdding] = useState(false);
  const [filter, setFilter] = useState('');
  const act = (p, msg) => p.then(() => { users.reload(); if (msg) toast(msg); }, (e) => toast(e.message));
  const [addUser, st] = useSubmit(async (e) => { await api('/admin/users', { method: 'POST', body: formData(e) }); setAdding(false); users.reload(); toast('User created'); });
  const list = (users.data || []).filter((u) => !filter || `${u.name} ${u.email}`.toLowerCase().includes(filter.toLowerCase()));

  return html`<div class="col">
    <div class="row between">
      <input class="input" style="max-width:260px" placeholder="Filter users…" value=${filter} onInput=${(e) => setFilter(e.target.value)} />
      <button class="btn sm" onClick=${() => setAdding(true)}>+ Add user</button>
    </div>
    <div class="panel" style="padding:0"><div class="scroll-x"><table class="list"><thead><tr><th>User</th><th>Role</th><th>Security</th><th>Usage</th><th>Last active</th><th /></tr></thead><tbody>
      ${list.map((u) => html`<tr>
        <td>${u.name}<div class="small muted">${u.email}</div></td>
        <td>${u.id === me.user.id ? u.role : html`<select class="input compact" value=${u.role} aria-label="Role"
          onChange=${(e) => act(api(`/admin/users/${u.id}`, { method: 'PUT', body: { role: e.target.value } }), 'Role updated')}>
          <option value="user">User</option><option value="admin">Admin</option></select>`}</td>
        <td class="small">${[u.sso && 'SSO', u.totp && '2FA', u.passkeys > 0 && `${u.passkeys} passkey${u.passkeys > 1 ? 's' : ''}`, !u.has_password && !u.sso && 'no password'].filter(Boolean).join(' · ') || html`<span class="faint">password</span>`}</td>
        <td class="small">${u.courses} courses · ${fmtBytes(u.storage)}</td>
        <td class="small muted">${u.last_seen ? timeAgo(u.last_seen) : 'never'}</td>
        <td style="text-align:right;white-space:nowrap">
          <details class="menu"><summary class="btn ghost sm">⋯</summary><div class="menu-list">
            <button onClick=${() => act(api(`/admin/users/${u.id}/logout`, { method: 'POST' }), 'Signed out everywhere')}>Sign out everywhere</button>
            ${u.totp && html`<button onClick=${() => confirm(`Remove two-factor authentication for ${u.email}? They will be signed out.`) && act(api(`/admin/users/${u.id}/reset-2fa`, { method: 'POST' }), '2FA reset')}>Reset 2FA</button>`}
            ${u.id !== me.user.id && html`<button class="danger" onClick=${() => confirm(`Delete ${u.email} and all their data?`) && act(api(`/admin/users/${u.id}`, { method: 'DELETE' }), 'User deleted')}>Delete user</button>`}
          </div></details>
        </td>
      </tr>`)}
    </tbody></table></div></div>
    ${adding && html`<${Modal} title="Add user" onClose=${() => setAdding(false)}>
      <form class="col" onSubmit=${addUser}>
        <label class="field">Email<input class="input" name="email" type="email" required /></label>
        <label class="field">Name<input class="input" name="name" /></label>
        <label class="field">Temporary password<input class="input" name="password" type="password" minlength="8" required autocomplete="new-password" /></label>
        <label class="field">Role<select class="input" name="role"><option value="user">User</option><option value="admin">Admin</option></select></label>
        ${st.error && html`<p class="error">${st.error}</p>`}
        <button class="btn primary" disabled=${st.busy}>Create user</button>
      </form>
    <//>`}
  </div>`;
}

function Access({ me }) {
  const s = useAsync(() => api('/admin/settings'));
  const [invite, setInvite] = useState(null);
  const act = (p, msg) => p.then(() => { s.reload(); if (msg) toast(msg); }, (e) => { toast(e.message); s.reload(); });
  const set = (body, msg = 'Saved') => act(api('/admin/settings', { method: 'PUT', body }), msg);
  const [makeInvite, inv] = useSubmit(async (e) => {
    const { email } = formData(e);
    const r = await api('/admin/invites', { method: 'POST', body: email ? { email } : {} });
    setInvite(r); e.target.reset(); s.reload();
    if (!r.emailed) navigator.clipboard?.writeText(r.link).then(() => toast('Invite link copied'), () => {});
    else toast(`Invite sent to ${email}`);
  });
  const d = s.data;
  if (!d) return s.error ? html`<p class="error">${s.error.message}</p>` : null;
  return html`<div class="col">
    <div class="panel col">
      <div class="section-title" style="margin:0">Sign-up & security</div>
      <label class="check"><input type="checkbox" checked=${d.allowRegistration} onChange=${(e) => set({ allowRegistration: e.target.checked })} /> Allow public sign-ups</label>
      <p class="small muted" style="margin-top:-6px">When off, people join with an invite link, an account you create, or SSO (if configured).</p>
      <label class="check"><input type="checkbox" checked=${d.requireEmailVerification} disabled=${!d.mail} onChange=${(e) => set({ requireEmailVerification: e.target.checked })} /> Require email confirmation for new sign-ups</label>
      ${!d.mail && html`<p class="small faint" style="margin-top:-6px">Needs SMTP (<code>SMTP_URL</code>).</p>`}
      <label class="check"><input type="checkbox" checked=${d.require2faAdmins} onChange=${(e) => set({ require2faAdmins: e.target.checked })} /> Require two-factor authentication for admins</label>
      <p class="small muted" style="margin-top:-6px">Admins signing in with only a password must set up an authenticator before they can do anything else. Passkey and SSO sign-ins are accepted.${!me.user.hasTotp ? ' Enable 2FA on your own account first.' : ''}</p>
    </div>

    <div class="panel col">
      <div class="section-title" style="margin:0">Invites</div>
      <form class="row" onSubmit=${makeInvite}>
        <input class="input grow" style="width:auto" name="email" type="email" placeholder=${d.mail ? 'Email (optional, sends the invite)' : 'Email sending not configured'} disabled=${!d.mail} />
        <button class="btn" disabled=${inv.busy}>Create invite link</button>
      </form>
      ${inv.error && html`<p class="error">${inv.error}</p>`}
      ${invite && html`<div class="row"><code class="small grow" style="overflow-wrap:anywhere">${invite.link}</code><button class="btn sm" onClick=${() => navigator.clipboard?.writeText(invite.link).then(() => toast('Copied'))}>Copy</button></div>`}
      ${d.invites.length > 0 && html`<div class="scroll-x"><table class="list"><tbody>
        ${d.invites.map((i) => html`<tr><td><code class="small">…${i.code.slice(-6)}</code></td>
          <td class="small muted">${i.used_by_email ? `used by ${i.used_by_email}` : i.expires_at < Date.now() ? 'expired' : `valid until ${fmtDate(i.expires_at)}`}</td>
          <td style="text-align:right">${!i.used_by_email && i.expires_at > Date.now() && html`<button class="btn ghost sm" onClick=${() => navigator.clipboard?.writeText(`${location.origin}/#/register?invite=${i.code}`).then(() => toast('Copied'))}>Copy link</button>`}
            <button class="btn ghost sm danger" onClick=${() => act(api(`/admin/invites/${encodeURIComponent(i.code)}`, { method: 'DELETE' }))}>Revoke</button></td></tr>`)}
      </tbody></table></div>`}
    </div>
  </div>`;
}

function Storage() {
  const s = useAsync(() => api('/admin/storage'));
  const [clean, st] = useSubmit(async () => { const r = await api('/admin/storage/cleanup', { method: 'POST' }); toast(`Removed ${r.removed} files (${fmtBytes(r.bytes)})`); s.reload(); });
  const d = s.data;
  if (!d) return s.error ? html`<p class="error">${s.error.message}</p>` : null;
  return html`<div class="col">
    <div class="panel row between">
      <div><b>${d.files} files</b><div class="small muted">${d.orphans} unused (${fmtBytes(d.orphanBytes)}): not used by any card for over 24 hours. Removed every night.</div></div>
      <button class="btn sm" onClick=${clean} disabled=${st.busy || !d.orphans}>Clean up now</button>
    </div>
    <div class="panel" style="padding:0"><table class="list"><thead><tr><th>User</th><th>Files</th><th>Storage</th></tr></thead><tbody>
      ${d.perUser.map((u) => html`<tr><td>${u.name}<div class="small muted">${u.email}</div></td><td>${u.files}</td><td>${fmtBytes(u.bytes)}</td></tr>`)}
    </tbody></table></div>
  </div>`;
}

function Audit() {
  const [filter, setFilter] = useState({ action: '', q: '' });
  const [pages, setPages] = useState([]);
  const first = useAsync(() => api(`/admin/audit?action=${encodeURIComponent(filter.action)}&q=${encodeURIComponent(filter.q)}`).then((r) => { setPages([]); return r; }), [filter.action, filter.q]);
  const rows = [...(first.data || []), ...pages];
  const more = async () => { const last = rows[rows.length - 1]; setPages([...pages, ...(await api(`/admin/audit?action=${encodeURIComponent(filter.action)}&q=${encodeURIComponent(filter.q)}&before=${last.id}`))]); };
  return html`<div class="col">
    <div class="row">
      <select class="input" style="width:auto" value=${filter.action} onChange=${(e) => setFilter({ ...filter, action: e.target.value })}>
        <option value="">All events</option><option value="auth.">Sign-ins & auth</option><option value="auth.login_failed">Failed sign-ins</option>
        <option value="account.">Account changes</option><option value="admin.">Admin actions</option><option value="course.">Courses & sharing</option><option value="backup.">Backups</option></select>
      <input class="input grow" style="width:auto" placeholder="Search user, target or IP…" value=${filter.q} onChange=${(e) => setFilter({ ...filter, q: e.target.value })} />
    </div>
    <div class="panel" style="padding:0"><div class="scroll-x"><table class="list"><thead><tr><th>When</th><th>Who</th><th>Event</th><th>Details</th></tr></thead><tbody>
      ${rows.map((r) => html`<tr>
        <td class="small" style="white-space:nowrap">${fmtDateTime(r.ts)}</td>
        <td class="small">${r.actor || html`<span class="faint">—</span>`}<div class="faint">${r.ip}</div></td>
        <td><code class="small">${r.action}</code>${r.target && html`<div class="small muted">${r.target}</div>`}</td>
        <td class="small muted" style="max-width:280px;overflow-wrap:anywhere">${r.details}</td>
      </tr>`)}
    </tbody></table></div></div>
    ${rows.length >= 100 && rows.length % 100 === 0 && html`<div><button class="btn sm" onClick=${more}>Load older</button></div>`}
  </div>`;
}
