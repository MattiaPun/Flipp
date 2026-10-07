import { html, render, useState, useEffect, useRef } from '/vendor/htm-preact.js';
import { api, setTheme, currentTheme, Icon, toast } from '/ui.js';
import { Setup, Login, Register, Forgot, Reset, Verify } from '/pages/auth.js';
import { Home } from '/pages/home.js';
import { Course } from '/pages/course.js';
import { SetPage } from '/pages/set.js';
import { Study } from '/pages/study.js';
import { Settings } from '/pages/settings.js';
import { Admin } from '/pages/admin.js';
import { Library, Tags, Leeches } from '/pages/browse.js';
import { Stats } from '/pages/stats.js';
import { Groups, Group, JoinGroup } from '/pages/groups.js';
import { flushReviews, pendingCount, setOfflineUser } from '/offline.js';

if ('serviceWorker' in navigator) addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));

// Close open dropdown menus when clicking elsewhere (or on a menu item).
document.addEventListener('click', (e) => {
  for (const d of document.querySelectorAll('details.menu[open]')) {
    if (!d.contains(e.target) || e.target.closest('.menu-list button, .menu-list a')) d.open = false;
  }
});

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

function useOnline() {
  const [online, setOnline] = useState(navigator.onLine);
  const [pending, setPending] = useState(pendingCount());
  useEffect(() => {
    const on = () => { setOnline(navigator.onLine); setPending(pendingCount()); };
    for (const ev of ['online', 'offline', 'flipp:offline-queue']) addEventListener(ev, on);
    return () => { for (const ev of ['online', 'offline', 'flipp:offline-queue']) removeEventListener(ev, on); };
  }, []);
  return { online, pending };
}

// ⌘K / Ctrl+K command palette: search courses, sets and cards; jump to pages; run actions.
function Palette({ me, onClose }) {
  const [q, setQ] = useState('');
  const [res, setRes] = useState(null);
  const [idx, setIdx] = useState(0);
  const input = useRef();
  useEffect(() => { input.current.focus(); }, []);
  useEffect(() => {
    if (q.trim().length < 2) { setRes(null); return; }
    const t = setTimeout(() => api(`/search?q=${encodeURIComponent(q.trim())}`).then(setRes, () => {}), 150);
    return () => clearTimeout(t);
  }, [q]);
  const commands = [
    { label: 'Review due cards', href: '#/study?mode=learn' },
    { label: 'Home', href: '#/' }, { label: 'Statistics', href: '#/stats' }, { label: 'Library', href: '#/library' },
    { label: 'Groups', href: '#/groups' }, { label: 'Tags', href: '#/tags' }, { label: 'Leeches', href: '#/leeches' }, { label: 'Settings', href: '#/settings' },
    ...(me.user.role === 'admin' ? [{ label: 'Admin', href: '#/admin' }, { label: 'Admin · Audit log', href: '#/admin?tab=audit' }, { label: 'Admin · Backups', href: '#/admin?tab=backups' }] : []),
    { label: 'Toggle dark / light theme', run: () => setTheme(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light') },
  ].filter((c) => !q || c.label.toLowerCase().includes(q.toLowerCase()));
  const items = [
    ...commands.map((c) => ({ ...c, group: 'Go to' })),
    ...(res?.courses || []).map((c) => ({ label: `${c.icon || '📚'} ${c.title}`, href: `#/course/${c.id}`, group: 'Courses' })),
    ...(res?.sets || []).map((s) => ({ label: `${s.title}`, hint: `${s.icon || ''} ${s.course_title}`, href: `#/set/${s.id}`, group: 'Sets' })),
    ...(res?.cards || []).map((c) => ({ label: c.front.slice(0, 80), hint: c.back.slice(0, 60), href: `#/set/${c.set_id}`, group: 'Cards' })),
  ];
  const go = (it) => { onClose(); if (it.run) it.run(); else location.hash = it.href; };
  const keys = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setIdx((i) => Math.min(items.length - 1, i + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setIdx((i) => Math.max(0, i - 1)); }
    else if (e.key === 'Enter' && items[idx]) { e.preventDefault(); go(items[idx]); }
    else if (e.key === 'Escape') onClose();
  };
  let lastGroup = '';
  return html`<div class="palette-backdrop" onClick=${(e) => e.target === e.currentTarget && onClose()}>
    <div class="palette pop" role="dialog" aria-label="Search">
      <div class="row" style="flex-wrap:nowrap;padding:4px 12px;border-bottom:1px solid var(--line)"><${Icon} name="search" />
        <input ref=${input} class="palette-input" value=${q} onInput=${(e) => { setQ(e.target.value); setIdx(0); }} onKeyDown=${keys} placeholder="Search cards, sets, courses or jump to…" aria-label="Search" /></div>
      <div class="palette-list">${items.length ? items.map((it, i) => {
        const header = it.group !== lastGroup ? html`<div class="palette-group">${(lastGroup = it.group)}</div>` : null;
        return html`${header}<button class="palette-item ${i === idx ? 'on' : ''}" onMouseEnter=${() => setIdx(i)} onClick=${() => go(it)}>
          <span class="grow" style="text-align:left;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${it.label}</span>${it.hint && html`<span class="small faint" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:40%">${it.hint}</span>`}</button>`;
      }) : html`<div class="small faint" style="padding:16px">No results</div>`}</div>
    </div>
  </div>`;
}

function Shell({ me, route, children, study }) {
  const top = route.parts[0] || '';
  const [theme, setT] = useState(currentTheme());
  const [palette, setPalette] = useState(false);
  const { online, pending } = useOnline();
  const dark = theme === 'dark' || (theme === 'system' && !matchMedia('(prefers-color-scheme: light)').matches);
  const toggle = () => { const t = dark ? 'light' : 'dark'; setTheme(t); setT(t); };
  useEffect(() => { document.body.classList.toggle('study-page', !!study); }, [study]);
  useEffect(() => {
    const k = (e) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPalette((p) => !p); } };
    addEventListener('keydown', k);
    return () => removeEventListener('keydown', k);
  }, []);
  const homeish = !top || ['course', 'set'].includes(top);
  const link = (href, label, on) => html`<a class="navlink ${on ? 'on' : ''}" href=${href} aria-current=${on ? 'page' : undefined}>${label}</a>`;
  const b = me.branding;
  return html`
    <header class="topbar">
      <a class="logo" href="#/">${b.logo ? html`<img src=${b.logo} alt="" class="logo-img" />` : html`<i />`}${b.name}</a>
      <nav>${link('#/', 'Home', homeish)}${link('#/study?mode=learn', 'Review', top === 'study')}${link('#/stats', 'Stats', top === 'stats')}${link('#/library', 'Library', top === 'library')}${link('#/groups', 'Groups', top === 'groups' || top === 'group')}${me.user.role === 'admin' && link('#/admin', 'Admin', top === 'admin')}</nav>
      <span class="spacer" />
      ${(!online || pending > 0) && html`<span class="tag ${online ? '' : 'warn'}" title="Reviews made offline sync automatically">${online ? `Syncing ${pending}…` : `Offline${pending ? ` · ${pending} queued` : ''}`}</span>`}
      <button class="btn ghost search-btn" onClick=${() => setPalette(true)} aria-label="Search (Ctrl+K)"><${Icon} name="search" /><span class="hide-sm">Search</span><kbd class="hide-sm">⌘K</kbd></button>
      <button class="btn ghost icon-btn" onClick=${toggle} title="Toggle theme" aria-label="Toggle theme"><${Icon} name=${dark ? 'sun' : 'moon'} /></button>
      <a class="btn ghost icon-btn hide-sm" href="#/settings" title="Settings" aria-label="Settings"><${Icon} name="gear" /></a>
    </header>
    <main id="main">${children}</main>
    <nav class="bottomnav" aria-label="Main">
      <a href="#/" class=${homeish ? 'on' : ''}><${Icon} name="home" />Home</a>
      <a href="#/study?mode=learn" class=${top === 'study' ? 'on' : ''}><${Icon} name="bolt" />Review</a>
      <a href="#/stats" class=${top === 'stats' ? 'on' : ''}><${Icon} name="chart" />Stats</a>
      <a href="#/library" class=${top === 'library' ? 'on' : ''}><${Icon} name="book" />Library</a>
      <a href="#/settings" class=${top === 'settings' || top === 'admin' ? 'on' : ''}><${Icon} name="gear" />Settings</a>
    </nav>
    ${palette && html`<${Palette} me=${me} onClose=${() => setPalette(false)} />`}`;
}

function App() {
  const route = useRoute();
  const [me, setMe] = useState(null);
  const [err, setErr] = useState('');
  const load = () => api('/auth/me').then((m) => {
    // Cached API responses belong to one account: drop them when a different (or no) user is signed in.
    const uid = String(m.user?.id ?? '');
    try { if (localStorage.getItem('flipp.uid') !== uid) { caches?.delete('flipp-api'); localStorage.setItem('flipp.uid', uid); } } catch {}
    setOfflineUser(m.user?.id);
    setMe(m); setErr('');
    document.title = m.branding.name;
    if (m.user) {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (tz && localStorage.getItem('flipp.tzSynced') !== tz) api('/account/prefs', { method: 'PUT', body: { tz } }).then(() => localStorage.setItem('flipp.tzSynced', tz), () => {});
      flushReviews();
    }
  }, (e) => setErr(e.message));
  useEffect(() => { load(); addEventListener('flipp:auth', load); return () => removeEventListener('flipp:auth', load); }, []);

  if (err) return html`<div class="auth"><div class="col" style="align-items:center"><p class="error">${err}</p><button class="btn" onClick=${load}>Retry</button></div></div>`;
  if (!me) return html`<div class="boot">Flipp</div>`;
  const done = () => {
    let back = '#/';
    try { back = sessionStorage.getItem('flipp.back') || back; sessionStorage.removeItem('flipp.back'); } catch {}
    location.hash = back; load();
  };
  const [page, id] = route.parts;
  const q = route.query;
  if (me.needsSetup) return html`<${Setup} me=${me} query=${q} onDone=${done} />`;
  if (!me.user) {
    if (page === 'register') return html`<${Register} me=${me} query=${q} onDone=${done} />`;
    if (page === 'forgot') return html`<${Forgot} me=${me} />`;
    if (page === 'reset') return html`<${Reset} me=${me} query=${q} />`;
    if (page === 'verify') return html`<${Verify} me=${me} query=${q} onDone=${done} />`;
    if (page && page !== 'login') try { sessionStorage.setItem('flipp.back', location.hash); } catch {}
    return html`<${Login} me=${me} query=${q} onDone=${done} />`;
  }
  const onLogout = () => { location.hash = '#/login'; try { localStorage.removeItem('flipp.tzSynced'); } catch {} try { caches?.delete('flipp-api'); navigator.serviceWorker?.controller?.postMessage('logout'); } catch {} load(); };
  // Admins required to set up 2FA can only reach the security settings.
  const forced = me.user.mfaSetupRequired;
  const view = forced ? html`<${Settings} me=${me} onLogout=${onLogout} reloadMe=${load} />`
    : page === 'course' ? html`<${Course} key=${id} me=${me} id=${id} />`
    : page === 'set' ? html`<${SetPage} key=${id} id=${id} />`
    : page === 'study' ? html`<${Study} key=${JSON.stringify(q)} query=${q} />`
    : page === 'settings' ? html`<${Settings} me=${me} onLogout=${onLogout} reloadMe=${load} />`
    : page === 'admin' ? html`<${Admin} me=${me} query=${q} reloadMe=${load} />`
    : page === 'library' ? html`<${Library} />`
    : page === 'tags' ? html`<${Tags} />`
    : page === 'leeches' ? html`<${Leeches} />`
    : page === 'stats' ? html`<${Stats} />`
    : page === 'groups' ? html`<${Groups} me=${me} />`
    : page === 'group' ? html`<${Group} key=${id} me=${me} id=${id} />`
    : page === 'join' ? html`<${JoinGroup} code=${id} />`
    : html`<${Home} me=${me} />`;
  return html`<${Shell} me=${me} route=${route} study=${page === 'study' && !forced}>${view}<//>`;
}

addEventListener('unhandledrejection', (e) => { if (e.reason?.offline) { e.preventDefault(); toast("You're offline"); } });
render(html`<${App} />`, document.getElementById('app'));
