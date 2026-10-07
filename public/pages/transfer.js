// Course export / Anki import (course menu) and course import (home).
import { html, useState } from '/vendor/htm-preact.js';
import { useSubmit, toast, Modal } from '/ui.js';

async function upload(url, file) {
  const res = await fetch(`/api${url}`, { method: 'POST', headers: { 'X-Flipp': '1', 'Content-Type': 'application/octet-stream' }, body: file });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

// Menu entries only: the dialog must render outside the menu, which closes (and hides its content) on click.
export function TransferButtons({ course, onAnki }) {
  return html`
    <a href=${`/api/courses/${course.id}/export`} download>Export course</a>
    ${course.canEdit && html`<button onClick=${onAnki}>Import Anki deck…</button>`}`;
}

export function AnkiDialog({ course, onClose, onImported }) {
  const [file, setFile] = useState(null);
  const [history, setHistory] = useState(true);
  const [run, st] = useSubmit(async () => {
    const r = await upload(`/courses/${course.id}/import/anki${history ? '?history=1' : ''}`, file);
    toast(`Imported ${r.cards} cards into ${r.sets} set${r.sets === 1 ? '' : 's'}${r.reviews ? ` with ${r.reviews} past reviews` : ''}`);
    onImported(); onClose();
  });
  return html`<${Modal} title="Import Anki deck" onClose=${onClose}>
    <div class="col">
      <p class="small muted">Choose an <code>.apkg</code> file exported from Anki. Each Anki deck becomes a set in this course. Basic, reversed and cloze notes are supported; images and audio come along.</p>
      <input type="file" accept=".apkg,.colpkg" onChange=${(e) => setFile(e.target.files[0])} />
      <label class="check"><input type="checkbox" checked=${history} onChange=${(e) => setHistory(e.target.checked)} /> Import my review history (keeps your Anki progress)</label>
      ${st.error && html`<p class="error">${st.error}</p>`}
      <button class="btn primary" disabled=${!file || st.busy} onClick=${run}>${st.busy ? 'Importing…' : 'Import'}</button>
    </div>
  <//>`;
}

export function ImportCourseButton() {
  const [busy, setBusy] = useState(false);
  const pick = async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    setBusy(true);
    try { const r = await upload('/courses/import', file); toast(`Imported ${r.cards} cards`); location.hash = `#/course/${r.id}`; }
    catch (err) { toast(err.message); }
    finally { setBusy(false); }
  };
  return html`<label class="btn sm ghost ${busy ? 'disabled' : ''}" title="Import a course exported from Flipp">${busy ? 'Importing…' : 'Import'}<input type="file" accept=".gz,.tgz,application/gzip" hidden onChange=${pick} /></label>`;
}
