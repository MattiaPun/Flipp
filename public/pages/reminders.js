// Settings → daily reminder via Web Push (needs HTTPS; on iPhone/iPad the app must be installed to the home screen).
import { html, useState } from '/vendor/htm-preact.js';
import { api, useAsync, toast } from '/ui.js';

const b64ToBytes = (b64) => {
  const s = atob((b64 + '='.repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
};

async function subscribe() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) throw new Error('Push notifications are not supported here. On iPhone/iPad, add Flipp to your home screen first.');
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('Notifications are blocked for this site');
  const reg = await navigator.serviceWorker.ready;
  const { publicKey } = await api('/push/key');
  const sub = (await reg.pushManager.getSubscription()) || (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(publicKey) }));
  await api('/push/subscribe', { method: 'POST', body: sub.toJSON() });
}

export function ReminderSettings() {
  const prefs = useAsync(() => api('/account/prefs'));
  const [busy, setBusy] = useState(false);
  const p = prefs.data;
  if (!p) return null;
  const save = async (reminder) => {
    setBusy(true);
    try {
      if (reminder) await subscribe();
      await api('/account/prefs', { method: 'PUT', body: { reminder } });
      toast(reminder ? `Daily reminder at ${reminder}` : 'Reminder off');
      prefs.reload();
    } catch (e) { toast(e.message); } finally { setBusy(false); }
  };
  const test = async () => { try { await subscribe(); const r = await api('/push/test', { method: 'POST' }); toast(`Sent to ${r.sent} device${r.sent === 1 ? '' : 's'}`); } catch (e) { toast(e.message); } };
  return html`<div class="panel col">
    <div class="section-title" style="margin:0">Daily reminder</div>
    <div class="row">
      <label class="check"><input type="checkbox" checked=${!!p.reminder} disabled=${busy} onChange=${(e) => save(e.target.checked ? p.reminder || '19:00' : null)} /> Remind me when cards are due</label>
      ${p.reminder && html`<input class="input compact" type="time" value=${p.reminder} disabled=${busy} onChange=${(e) => e.target.value && save(e.target.value)} aria-label="Reminder time" style="width:auto" />
        <button class="btn sm ghost" onClick=${test}>Send a test</button>`}
    </div>
    <p class="small faint">Uses push notifications on this device (enable it on each device you use). Needs HTTPS; on iPhone and iPad, add the app to your home screen first.</p>
  </div>`;
}
