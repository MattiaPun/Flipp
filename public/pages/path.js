// Learning path: a set's cards in units along a winding trail. Each unit is a short lesson; the next unit opens
// once every card in the one before it has been answered.
import { html, useRef, useEffect } from '/vendor/htm-preact.js';
import { Icon } from '/ui.js';
import { pathUnits } from '/lib.js';

const WAVE = [0, 1, 2, 1, 0, -1, -2, -1]; // vertical offset per node, in steps

export function Path({ set }) {
  const units = pathUnits(set.cards);
  const current = units.findIndex((u) => u.open && !u.done);
  const strip = useRef();
  useEffect(() => { strip.current?.querySelector('.current')?.scrollIntoView({ inline: 'center', block: 'nearest' }); }, [set.id]);
  if (units.length < 2) return null; // one unit is just "Learn"
  return html`<div class="path-wrap">
    <div class="row between"><div class="section-title" style="margin:0">Path</div>
      <span class="small muted">${units.filter((u) => u.done).length} of ${units.length} units done</span></div>
    <ol class="path" ref=${strip}>${units.map((u, i) => {
      const state = u.mastered ? 'mastered' : u.done ? 'done' : i === current ? 'current' : u.open ? 'open' : 'locked';
      const label = html`<span class="node"><${Icon} name=${u.mastered ? 'star' : u.done ? 'check' : u.open ? 'play' : 'lock'} size=${22} fill=${u.mastered} /></span>
        <span class="unit-label">Unit ${i + 1}</span><span class="small muted">${u.seen}/${u.size}</span>`;
      return html`<li class=${state} style=${{ '--y': WAVE[i % WAVE.length] }}>
        ${u.open
          ? html`<a href=${`#/study?set=${set.id}&mode=lesson&unit=${i}`} title=${`Unit ${i + 1}: ${u.done ? 'practice again' : 'start lesson'}`}>${label}</a>`
          : html`<span title="Finish the unit before this one to open it">${label}</span>`}
      </li>`;
    })}</ol>
  </div>`;
}
