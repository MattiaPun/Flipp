// Settings: appearance & study feedback, profile, password, two-factor, passkeys, sessions, export, delete account.
import { html, useState } from '/vendor/htm-preact.js';
import { api, useAsync, useSubmit, formData, prefs, toast, setTheme, currentTheme, Modal, fmtDate, timeAgo, Icon } from '/ui.js';
import { ReminderSettings } from '/pages/reminders.js';
import { Optimizer } from '/pages/stats.js';

const webauthn = () => import('/vendor/webauthn/index.js');

export function Settings({ me, onLogout, reloadMe }) {
  const [theme, setT] = useState(currentTheme());
  const [local, setLocal] = useState({ sound: prefs.get('sound', true), haptics: prefs.get('haptics', true) });
  const toggle = (k) => (e) => { prefs.set(k, e.target.checked); setLocal({ ...local, [k]: e.target.checked }); };
  const logout = async () => { await api('/auth/logout', { method: 'POST' }); onLogout(); };

  if (me.user.mfaSetupRequired) {
    return html`<div class="stack">
      <div class="panel col" style="border-color:var(--warn)"><h2>Two-factor authentication required</h2>
        <p class="muted">An administrator requires admins to use two-factor authentication. Set it up below to continue, or sign in with a passkey.</p></div>
      <${Security} me=${me} reloadMe=${reloadMe} />
      <div><button class="btn danger" onClick=${logout}>Sign out</button></div>
    </div>`;
  }

  return html`<div class="stack">
    <h1>Settings</h1>
    <div class="panel col">
      <div class="section-title" style="margin:0">Appearance & study</div>
      <label class="field">Theme<select class="input" value=${theme} onChange=${(e) => { setTheme(e.target.value); setT(e.target.value); }}>
        <option value="system">Match system</option><option value="dark">Dark</option><option value="light">Light</option></select></label>
      <label class="check"><input type="checkbox" checked=${local.sound} onChange=${toggle('sound')} /> Sound effects</label>
      <label class="check"><input type="checkbox" checked=${local.haptics} onChange=${toggle('haptics')} /> Haptics (where supported)</label>
    </div>
    <${ReminderSettings} />
    <${Optimizer} />
    <${Profile} me=${me} reloadMe=${reloadMe} />
    <${Security} me=${me} reloadMe=${reloadMe} />
    <${DataAndDeletion} me=${me} onLogout=${onLogout} />
    <div class="row">${me.user.role === 'admin' && html`<a class="btn" href="#/admin">Admin</a>`}<button class="btn danger" onClick=${logout}>Sign out</button></div>
  </div>`;
}

function Profile({ me, reloadMe }) {
  const [saveName, sn] = useSubmit(async (e) => { await api('/account/me', { method: 'PUT', body: formData(e) }); toast('Name saved'); reloadMe(); });
  const [changePw, st] = useSubmit(async (e) => { await api('/account/password', { method: 'POST', body: formData(e) }); e.target.reset(); toast('Password updated. Other devices were signed out.'); });
  return html`<div class="panel col">
    <div class="section-title" style="margin:0">Account</div>
    <p class="muted small">${me.user.email} · ${me.user.role}${me.user.sso ? ' · SSO' : ''}</p>
    <form class="row" onSubmit=${saveName}>
      <input class="input grow" style="width:auto" name="name" value=${me.user.name} required maxlength="80" aria-label="Name" />
      <button class="btn" disabled=${sn.busy}>Save name</button>
    </form>
    ${sn.error && html`<p class="error">${sn.error}</p>`}
    <form class="col" onSubmit=${changePw}>
      <div class="row"><input class="input grow" style="width:auto" name="current" type="password" placeholder="Current password" autocomplete="current-password" />
        <input class="input grow" style="width:auto" name="password" type="password" placeholder="New password (8+)" minlength="8" required autocomplete="new-password" />
        <button class="btn" disabled=${st.busy}>Change password</button></div>
      ${st.error && html`<p class="error">${st.error}</p>`}
    </form>
  </div>`;
}

function Security({ me, reloadMe }) {
  const sec = useAsync(() => api('/account/security'));
  const [totpSetup, setTotpSetup] = useState(null);
  const [codes, setCodes] = useState(null);
  const [disable, setDisable] = useState(false);
  const s = sec.data;
  const startTotp = async () => setTotpSetup(await api('/account/totp/setup', { method: 'POST' }));
  const [enable, en] = useSubmit(async (e) => {
    const r = await api('/account/totp/enable', { method: 'POST', body: { ticket: totpSetup.ticket, code: formData(e).code } });
    setTotpSetup(null); setCodes(r.recoveryCodes); sec.reload(); reloadMe();
  });
  const [doDisable, dis] = useSubmit(async (e) => { await api('/account/totp/disable', { method: 'POST', body: formData(e) }); setDisable(false); sec.reload(); reloadMe(); toast('Two-factor authentication disabled'); });
  const regen = async () => {
    const code = prompt('Enter a current 6-digit code to generate new recovery codes:');
    if (!code) return;
    try { setCodes((await api('/account/totp/recovery-codes', { method: 'POST', body: { code } })).recoveryCodes); sec.reload(); } catch (e) { toast(e.message); }
  };
  const [addPasskey, ap] = useSubmit(async () => {
    const { startRegistration } = await webauthn();
    const optionsJSON = await api('/account/passkeys/options', { method: 'POST' });
    let response;
    try { response = await startRegistration({ optionsJSON }); } catch (e) { throw new Error(e.name === 'NotAllowedError' ? 'Cancelled' : e.name === 'InvalidStateError' ? 'This device already has a passkey for your account' : e.message); }
    const name = prompt('Name this passkey (e.g. "iPhone", "YubiKey")', guessDevice()) || 'Passkey';
    await api('/account/passkeys/verify', { method: 'POST', body: { response, name } });
    sec.reload();
    toast('Passkey added');
  });
  const act = (p, msg) => p.then(() => { sec.reload(); if (msg) toast(msg); }, (e) => toast(e.message));

  if (!s) return html`<div class="panel">${sec.error ? html`<p class="error">${sec.error.message}</p>` : html`<span class="faint">Loading security…</span>`}</div>`;
  return html`<div class="panel col">
    <div class="section-title" style="margin:0">Security</div>

    <div class="row between">
      <div><b>Two-factor authentication</b><div class="small muted">${s.hasTotp ? `On · ${s.recoveryCodesLeft} recovery codes left` : 'Use an authenticator app for a second sign-in step.'}</div></div>
      ${s.hasTotp
        ? html`<div class="row"><button class="btn sm" onClick=${regen}>New recovery codes</button><button class="btn sm ghost danger" onClick=${() => setDisable(true)}>Disable</button></div>`
        : html`<button class="btn sm primary" onClick=${() => startTotp().catch((e) => toast(e.message))}>Set up</button>`}
    </div>

    <div class="row between" style="margin-top:6px">
      <div><b>Passkeys</b><div class="small muted">Sign in with Face ID, Touch ID, Windows Hello or a security key.</div></div>
      <button class="btn sm" onClick=${addPasskey} disabled=${ap.busy}>Add passkey</button>
    </div>
    ${ap.error && html`<p class="error">${ap.error}</p>`}
    ${s.passkeys.length > 0 && html`<table class="list"><tbody>${s.passkeys.map((p) => html`<tr>
      <td><${Icon} name="key" size=${14} /> ${p.name}</td><td class="small muted">added ${fmtDate(p.created_at)}${p.last_used ? ` · used ${timeAgo(p.last_used)}` : ''}</td>
      <td style="text-align:right;white-space:nowrap">
        <button class="btn ghost sm" onClick=${() => { const n = prompt('Rename passkey', p.name); if (n) act(api(`/account/passkeys/${encodeURIComponent(p.id)}`, { method: 'PATCH', body: { name: n } })); }}>Rename</button>
        <button class="btn ghost sm danger" onClick=${() => confirm(`Remove passkey "${p.name}"?`) && act(api(`/account/passkeys/${encodeURIComponent(p.id)}`, { method: 'DELETE' }), 'Passkey removed')}>Remove</button></td></tr>`)}</tbody></table>`}

    <div class="row between" style="margin-top:6px">
      <div><b>Signed-in devices</b><div class="small muted">${s.sessions.length} active session${s.sessions.length === 1 ? '' : 's'}</div></div>
      ${s.sessions.length > 1 && html`<button class="btn sm" onClick=${() => act(api('/account/security/sessions/revoke-others', { method: 'POST' }), 'Other devices signed out')}>Sign out other devices</button>`}
    </div>
    <div class="scroll-x"><table class="list"><tbody>${s.sessions.map((x) => html`<tr>
      <td>${describeUA(x.user_agent)}${x.current && html` <span class="tag">this device</span>`}<div class="small faint">${x.ip || 'unknown IP'} · ${x.method}</div></td>
      <td class="small muted">active ${timeAgo(x.last_seen)}<div class="faint">since ${fmtDate(x.created_at)}</div></td>
      <td style="text-align:right">${!x.current && html`<button class="btn ghost sm danger" onClick=${() => act(api(`/account/security/sessions/${x.id}`, { method: 'DELETE' }), 'Signed out')}>Sign out</button>`}</td>
    </tr>`)}</tbody></table></div>

    ${totpSetup && html`<${Modal} title="Set up two-factor authentication" onClose=${() => setTotpSetup(null)}>
      <div class="col">
        <p class="small muted">1. Scan this QR code with an authenticator app (1Password, Bitwarden, Google Authenticator, Aegis, …).</p>
        <img class="qr" src=${'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(totpSetup.qr)} alt="QR code for your authenticator app" />
        <details class="small"><summary class="muted">Can't scan? Enter the key manually</summary><code class="secret">${totpSetup.secret.replace(/(.{4})/g, '$1 ').trim()}</code>
          <p><a class="link" href=${totpSetup.url}>Open in authenticator app</a></p></details>
        <form class="col" onSubmit=${enable}>
          <label class="field">2. Enter the 6-digit code it shows<input class="input code-input" name="code" required autofocus inputmode="numeric" autocomplete="one-time-code" maxlength="6" /></label>
          ${en.error && html`<p class="error">${en.error}</p>`}
          <button class="btn primary" disabled=${en.busy}>Turn on</button>
        </form>
      </div>
    <//>`}
    ${codes && html`<${Modal} title="Save your recovery codes" onClose=${() => setCodes(null)}>
      <div class="col">
        <p class="small muted">Each code works once if you lose your authenticator. Store them somewhere safe — they won't be shown again.</p>
        <div class="codes">${codes.map((c) => html`<code>${c}</code>`)}</div>
        <div class="row"><button class="btn" onClick=${() => navigator.clipboard?.writeText(codes.join('\n')).then(() => toast('Copied'))}>Copy</button>
          <button class="btn primary" onClick=${() => setCodes(null)}>I saved them</button></div>
      </div>
    <//>`}
    ${disable && html`<${Modal} title="Disable two-factor authentication" onClose=${() => setDisable(false)}>
      <form class="col" onSubmit=${doDisable}>
        ${s.hasPassword && html`<label class="field">Current password<input class="input" name="password" type="password" required autocomplete="current-password" /></label>`}
        <label class="field">Authenticator code<input class="input code-input" name="code" required inputmode="numeric" maxlength="6" autocomplete="one-time-code" /></label>
        ${dis.error && html`<p class="error">${dis.error}</p>`}
        <button class="btn danger" disabled=${dis.busy}>Disable</button>
      </form>
    <//>`}
  </div>`;
}

function DataAndDeletion({ me, onLogout }) {
  const [deleting, setDeleting] = useState(false);
  const sec = useAsync(() => api('/account/security'));
  const [del, st] = useSubmit(async (e) => { await api('/account', { method: 'DELETE', body: formData(e) }); onLogout(); });
  const s = sec.data;
  return html`<div class="panel col">
    <div class="section-title" style="margin:0">Your data</div>
    <div class="row between"><div><b>Export everything</b><div class="small muted">Your courses, cards, progress and review history plus your uploaded files, as a .tar.gz.</div></div>
      <a class="btn sm" href="/api/account/export" download>Download</a></div>
    <div class="row between"><div><b>Delete account</b><div class="small muted">Permanently removes your account, your courses and all progress.</div></div>
      <button class="btn sm danger" onClick=${() => setDeleting(true)}>Delete…</button></div>
    ${deleting && s && html`<${Modal} title="Delete your account?" onClose=${() => setDeleting(false)}>
      <form class="col" onSubmit=${del}>
        <p class="small muted">This deletes your account, every course you own (including public ones), and all your progress. It cannot be undone.</p>
        ${s.hasPassword
          ? html`<label class="field">Current password<input class="input" name="password" type="password" required autocomplete="current-password" /></label>`
          : s.hasTotp
            ? html`<label class="field">Authenticator code<input class="input" name="code" required inputmode="numeric" maxlength="6" /></label>`
            : html`<label class="field">Type your email (${me.user.email}) to confirm<input class="input" name="confirm" required autocomplete="off" /></label>`}
        ${st.error && html`<p class="error">${st.error}</p>`}
        <button class="btn danger" disabled=${st.busy}>Delete my account</button>
      </form>
    <//>`}
  </div>`;
}

function guessDevice() {
  const ua = navigator.userAgent;
  return /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Mac/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows PC' : 'Passkey';
}
export function describeUA(ua = '') {
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : /curl|node|undici/i.test(ua) ? 'Script' : 'Browser';
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : '';
  return `${browser}${os ? ` on ${os}` : ''}`;
}
