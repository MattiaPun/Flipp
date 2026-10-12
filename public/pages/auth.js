// Signed-out screens: first-run setup, sign in (password / passkey / SSO / 2FA step), register, password reset, email confirmation.
import { html, useState, useEffect } from '/vendor/htm-preact.js';
import { api, useSubmit, formData, toast } from '/ui.js';

const webauthn = () => import('/vendor/webauthn/index.js');

function AuthShell({ me, title, subtitle, children }) {
  return html`<div class="auth"><div class="panel col pop" style="gap:16px">
    <div class="logo" style="font-size:18px"><i />Flipp</div>
    <div><h1 style="font-size:22px">${title}</h1>${subtitle && html`<p class="muted small" style="margin-top:4px">${subtitle}</p>`}</div>
    ${children}
  </div></div>`;
}

const SsoButton = ({ me, setup }) => me.oidc && html`<a class="btn lg" href=${`/api/auth/oidc/login${setup ? `?setup=${encodeURIComponent(setup)}` : ''}`}>Continue with ${me.oidc.name}</a>`;

export function Setup({ me, query, onDone }) {
  const [token, setToken] = useState(query.token || '');
  const [submit, st] = useSubmit(async (e) => { await api('/auth/setup', { method: 'POST', body: { ...formData(e), token } }); onDone(); });
  return html`<${AuthShell} me=${me} title="Welcome to Flipp" subtitle="Create the administrator account for this instance.">
    <form class="col" onSubmit=${submit}>
      <label class="field">Setup token
        <input class="input" value=${token} onInput=${(e) => setToken(e.target.value)} required autocomplete="off" spellcheck="false" placeholder="From the server logs" />
        <span class="small faint">Printed in the container logs on first start (<code>docker compose logs flipp</code>), or the value of <code>SETUP_TOKEN</code>.</span>
      </label>
      <label class="field">Name<input class="input" name="name" autocomplete="name" /></label>
      <label class="field">Email<input class="input" name="email" type="email" required autocomplete="email" /></label>
      <label class="field">Password<input class="input" name="password" type="password" minlength="8" required autocomplete="new-password" /></label>
      ${st.error && html`<p class="error">${st.error}</p>`}
      <button class="btn primary lg" disabled=${st.busy}>Create admin account</button>
    </form>
    ${me.oidc && html`<div class="divider">or</div><${SsoButton} me=${me} setup=${token} /><p class="small faint">With a valid setup token, the first SSO sign-in becomes the administrator.</p>`}
  <//>`;
}

export function Login({ me, query, onDone }) {
  const [ticket, setTicket] = useState(null);
  const [unverified, setUnverified] = useState('');
  const [submit, st] = useSubmit(async (e) => {
    const body = formData(e);
    try {
      const r = await api('/auth/login', { method: 'POST', body });
      if (r.mfa) return setTicket(r.ticket);
      onDone();
    } catch (err) {
      if (err.code === 'email_unverified') setUnverified(body.email);
      throw err;
    }
  });
  const [passkey, pk] = useSubmit(async () => {
    const { startAuthentication } = await webauthn();
    const optionsJSON = await api('/auth/passkey/options', { method: 'POST', body: {} });
    let response;
    try { response = await startAuthentication({ optionsJSON }); } catch (e) { throw new Error(e.name === 'NotAllowedError' ? 'Passkey sign-in was cancelled' : e.message); }
    await api('/auth/passkey/verify', { method: 'POST', body: response });
    onDone();
  });
  if (ticket) return html`<${MfaStep} me=${me} ticket=${ticket} onDone=${onDone} onBack=${() => setTicket(null)} />`;
  const resend = async () => { await api('/auth/verify/resend', { method: 'POST', body: { email: unverified } }); toast('If that account exists, a new link is on its way'); };
  const hasWebauthn = typeof window.PublicKeyCredential === 'function';

  return html`<${AuthShell} me=${me} title="Sign in" subtitle="Pick up where you left off.">
    ${query.error && html`<p class="error">Single sign-on failed. Try again, or ask your admin to check the server logs.</p>`/* fixed text: the hash is attacker-controllable */}
    <${SsoButton} me=${me} />
    ${me.oidc && html`<div class="divider">or</div>`}
    <form class="col" onSubmit=${submit}>
      <label class="field">Email<input class="input" name="email" type="email" required autocomplete="username webauthn" /></label>
      <label class="field">Password<input class="input" name="password" type="password" required autocomplete="current-password" /></label>
      ${st.error && html`<p class="error">${st.error}</p>`}
      ${unverified && html`<button type="button" class="btn sm ghost" onClick=${resend}>Send a new confirmation link</button>`}
      <button class="btn primary lg" disabled=${st.busy}>Sign in</button>
    </form>
    ${hasWebauthn && html`<button class="btn lg" onClick=${passkey} disabled=${pk.busy}>Sign in with a passkey</button>${pk.error && html`<p class="error">${pk.error}</p>`}`}
    <div class="row between small muted">
      ${me.allowRegistration ? html`<span>No account? <a href="#/register" class="link">Create one</a></span>` : html`<span />`}
      ${me.mail && html`<a href="#/forgot" class="link">Forgot password?</a>`}
    </div>
  <//>`;
}

function MfaStep({ me, ticket, onDone, onBack }) {
  const [recovery, setRecovery] = useState(false);
  const [submit, st] = useSubmit(async (e) => { await api('/auth/login/mfa', { method: 'POST', body: { ticket, code: formData(e).code } }); onDone(); });
  return html`<${AuthShell} me=${me} title="Two-factor authentication" subtitle=${recovery ? 'Enter one of your recovery codes.' : 'Enter the 6-digit code from your authenticator app.'}>
    <form class="col" onSubmit=${submit}>
      <input class="input code-input" name="code" required autofocus autocomplete="one-time-code" inputmode=${recovery ? 'text' : 'numeric'}
        placeholder=${recovery ? 'xxxx-xxxx' : '123456'} maxlength=${recovery ? 20 : 6} />
      ${st.error && html`<p class="error">${st.error}</p>`}
      <button class="btn primary lg" disabled=${st.busy}>Verify</button>
    </form>
    <div class="row between small">
      <button class="btn ghost sm" onClick=${() => setRecovery(!recovery)}>${recovery ? 'Use authenticator code' : 'Use a recovery code'}</button>
      <button class="btn ghost sm" onClick=${onBack}>Back</button>
    </div>
  <//>`;
}

export function Register({ me, query, onDone }) {
  const [sent, setSent] = useState(false);
  const [submit, st] = useSubmit(async (e) => {
    const r = await api('/auth/register', { method: 'POST', body: { ...formData(e), invite: query.invite } });
    if (r.verify) setSent(true); else onDone();
  });
  if (sent) return html`<${AuthShell} me=${me} title="Check your inbox" subtitle="We sent you a link to confirm your email address. It expires in 24 hours."><a class="btn" href="#/login">Back to sign in</a><//>`;
  if (!me.allowRegistration && !query.invite) {
    return html`<${AuthShell} me=${me} title="Invite only" subtitle="Registration is closed on this instance. Ask an admin for an invite link."><a class="btn" href="#/login">Back to sign in</a><//>`;
  }
  return html`<${AuthShell} me=${me} title="Create account" subtitle=${query.invite ? "You've been invited." : 'Start learning in seconds.'}>
    <form class="col" onSubmit=${submit}>
      <label class="field">Name<input class="input" name="name" autocomplete="name" /></label>
      <label class="field">Email<input class="input" name="email" type="email" required autocomplete="email" /></label>
      <label class="field">Password<input class="input" name="password" type="password" minlength="8" required autocomplete="new-password" /></label>
      ${st.error && html`<p class="error">${st.error}</p>`}
      <button class="btn primary lg" disabled=${st.busy}>Create account</button>
    </form>
    <p class="small muted">Have an account? <a href="#/login" class="link">Sign in</a></p>
  <//>`;
}

export function Forgot({ me }) {
  const [sent, setSent] = useState(false);
  const [submit, st] = useSubmit(async (e) => { await api('/auth/forgot', { method: 'POST', body: formData(e) }); setSent(true); });
  return html`<${AuthShell} me=${me} title="Reset password" subtitle=${sent ? 'If an account exists for that email, a reset link is on its way. It expires in 1 hour.' : "We'll email you a link to choose a new password."}>
    ${!sent && html`<form class="col" onSubmit=${submit}>
      <label class="field">Email<input class="input" name="email" type="email" required autocomplete="email" /></label>
      ${st.error && html`<p class="error">${st.error}</p>`}
      <button class="btn primary lg" disabled=${st.busy}>Send reset link</button>
    </form>`}
    <a class="small muted link" href="#/login">Back to sign in</a>
  <//>`;
}

export function Reset({ me, query }) {
  const [done, setDone] = useState(false);
  const [submit, st] = useSubmit(async (e) => {
    const { password, confirm } = formData(e);
    if (password !== confirm) throw new Error("Passwords don't match");
    await api('/auth/reset', { method: 'POST', body: { token: query.token, password } });
    setDone(true);
  });
  return html`<${AuthShell} me=${me} title="Choose a new password" subtitle=${done ? 'Password changed. You were signed out on all devices.' : ''}>
    ${done ? html`<a class="btn primary" href="#/login">Sign in</a>` : html`<form class="col" onSubmit=${submit}>
      <label class="field">New password<input class="input" name="password" type="password" minlength="8" required autocomplete="new-password" /></label>
      <label class="field">Repeat<input class="input" name="confirm" type="password" minlength="8" required autocomplete="new-password" /></label>
      ${st.error && html`<p class="error">${st.error}</p>`}
      <button class="btn primary lg" disabled=${st.busy}>Save password</button>
    </form>`}
  <//>`;
}

export function Verify({ me, query, onDone }) {
  const [state, setState] = useState({ busy: true });
  useEffect(() => {
    api('/auth/verify', { method: 'POST', body: { token: query.token } })
      .then((r) => (r.login ? setState({ login: true }) : onDone()), (e) => setState({ error: e.message }));
  }, []);
  return html`<${AuthShell} me=${me} title="Confirming your email" subtitle=${state.busy ? 'One moment…' : state.login ? 'Email confirmed. Sign in to continue.' : ''}>
    ${state.error && html`<p class="error">${state.error}</p>`}
    ${(state.error || state.login) && html`<a class="btn" href="#/login">Go to sign in</a>`}
  <//>`;
}
