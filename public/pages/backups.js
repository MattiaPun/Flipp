// Admin → Backups: create / download / delete, schedule, restore from a stored or uploaded file.
import { html, useState } from '/vendor/htm-preact.js';
import { api, useAsync, useSubmit, formData, toast, Modal, fmtBytes, fmtDateTime } from '/ui.js';

export function Backups() {
  const b = useAsync(() => api('/admin/backups'));
  const [restoring, setRestoring] = useState(null); // backup name, or { file }
  const [create, cr] = useSubmit(async () => { const r = await api('/admin/backups', { method: 'POST' }); toast(`Backup created: ${r.name}`); b.reload(); });
  const [saveSchedule, ss] = useSubmit(async (e) => {
    const f = formData(e);
    await api('/admin/backups/schedule', { method: 'PUT', body: { enabled: f.enabled === 'on', hour: Number(f.hour), keep: Number(f.keep) } });
    toast('Schedule saved'); b.reload();
  });
  const del = async (name) => { if (!confirm(`Delete ${name}?`)) return; await api(`/admin/backups/${encodeURIComponent(name)}`, { method: 'DELETE' }).catch((e) => toast(e.message)); b.reload(); };
  const d = b.data;
  if (!d) return b.error ? html`<p class="error">${b.error.message}</p>` : null;
  return html`<div class="col">
    <div class="panel col">
      <div class="row between"><div><b>Backups</b><div class="small muted">Everything — database and uploaded files — in one portable .tar.gz. Stored in <code>${d.dir}</code>.</div></div>
        <button class="btn primary sm" onClick=${create} disabled=${cr.busy}>${cr.busy ? 'Creating…' : 'Back up now'}</button></div>
      ${cr.error && html`<p class="error">${cr.error}</p>`}
      ${d.files.length ? html`<div class="scroll-x"><table class="list"><tbody>${d.files.map((f) => html`<tr>
        <td><code class="small">${f.name}</code><div class="small faint">${f.kind}</div></td><td class="small muted">${fmtDateTime(f.created)}</td><td class="small">${fmtBytes(f.size)}</td>
        <td style="text-align:right;white-space:nowrap"><a class="btn ghost sm" href=${`/api/admin/backups/${encodeURIComponent(f.name)}`} download>Download</a>
          <button class="btn ghost sm" onClick=${() => setRestoring(f.name)}>Restore</button>
          <button class="btn ghost sm danger" onClick=${() => del(f.name)}>Delete</button></td></tr>`)}</tbody></table></div>`
        : html`<p class="small muted">No backups yet.</p>`}
      <div><label class="btn sm">Restore from a file…<input type="file" accept=".gz,application/gzip" hidden onChange=${(e) => { const file = e.target.files[0]; e.target.value = ''; if (file) setRestoring({ file }); }} /></label></div>
    </div>
    <form class="panel col" onSubmit=${saveSchedule}>
      <div class="section-title" style="margin:0">Automatic backups</div>
      <label class="check"><input type="checkbox" name="enabled" checked=${d.schedule.enabled} /> Back up every day</label>
      <div class="row">
        <label class="field">At hour (server time zone)<input class="input" type="number" name="hour" min="0" max="23" value=${d.schedule.hour} style="width:110px" /></label>
        <label class="field">Keep the newest<input class="input" type="number" name="keep" min="1" max="365" value=${d.schedule.keep} style="width:110px" /></label>
      </div>
      <p class="small faint">For off-site copies, mount <code>/data/backups</code> on another disk or sync it with your usual backup tool.</p>
      ${ss.error && html`<p class="error">${ss.error}</p>`}
      <div><button class="btn" disabled=${ss.busy}>Save schedule</button></div>
    </form>
    ${restoring && html`<${RestoreDialog} target=${restoring} onClose=${() => setRestoring(null)} />`}
  </div>`;
}

function RestoreDialog({ target, onClose }) {
  const [confirmText, setConfirm] = useState('');
  const [run, st] = useSubmit(async () => {
    if (typeof target === 'string') await api(`/admin/backups/${encodeURIComponent(target)}/restore`, { method: 'POST', body: { confirm: confirmText } });
    else {
      const res = await fetch('/api/admin/backups-upload', { method: 'POST', headers: { 'X-Flipp': '1', 'X-Confirm': confirmText, 'Content-Type': 'application/gzip' }, body: target.file });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
    }
    toast('Restored. The server is restarting…');
    // Full reload: the old session, cached API data and in-memory state all belong to the replaced instance.
    setTimeout(() => { try { caches?.delete('flipp-api'); } catch {} location.replace('/#/login'); location.reload(); }, 4000);
  });
  return html`<${Modal} title="Restore backup" onClose=${onClose}>
    <div class="col">
      <p><b>${typeof target === 'string' ? target : target.file.name}</b></p>
      <p class="small muted">This <b>replaces everything</b> on this instance — users, courses, progress, settings and uploaded files — with the backup's contents. Everyone is signed out and the server restarts. Keep the same <code>JWT_SECRET</code> so two-factor secrets stay readable.</p>
      <label class="field">Type RESTORE to confirm<input class="input" value=${confirmText} onInput=${(e) => setConfirm(e.target.value)} autocomplete="off" /></label>
      ${st.error && html`<p class="error">${st.error}</p>`}
      <button class="btn danger" disabled=${confirmText !== 'RESTORE' || st.busy} onClick=${run}>${st.busy ? 'Restoring…' : 'Replace everything'}</button>
    </div>
  <//>`;
}
