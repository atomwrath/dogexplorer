/* ============================ THE ONE OPEN-STATE ============================

   Everything that slides over the walk -- the map sheet and the settings drawer -- is
   one drawer with two panes, and this module owns the single value that says which of
   them is showing.

   WHAT THIS REPLACED, AND WHY. There used to be two toggles that had nothing to do with
   each other. The map lived on `body.bigmap`, driven by a 🗺 button under the minimap and
   closed by a ✕ in the sheet's top-left corner. Settings lived on `body.panelopen` OR
   `body.nopanel` -- two classes, because the panel rested open in the lobby and closed
   during a walk -- plus a third, `body.panel-open`, that existed only so the CSS would not
   have to reason about the first two. The ⚙ tab that opened it was pinned to the top-left
   and JUMPED to the top-right once open, which is to say the same corner meant "open
   settings", "close settings" and "close the map" depending on state nobody could see.

   Four classes, two idioms, and both surfaces openable at once so they could stack. The
   fix is not better labels on the buttons; it is that there was never more than one
   question being asked. `openPane` is that question, and it has three answers.

   The projection onto the DOM lives here too -- `body[data-pane]`, the segmented tabs'
   selected state, and minimap.js's draw gate. Callers set the value; nobody else writes
   the class, and nothing derives a second copy of it to disagree with.

   The DEPENDENCY DIRECTION is deliberate: this module imports minimap.js and pushes the
   draw gate down via setBigMapOpen(). It does not import main.js -- opening a pane may
   want to poke something over there (a resize, a redraw), so main.js hands a callback in
   through initPanes() the same way it hands its pick handlers to initMinimap(). Nothing
   below this module knows a pane exists. */

import { setBigMapOpen } from './minimap.js';

let openPane = null;            // 'map' | 'settings' | null -- the whole state
let onPaneChange = null;        // main.js's hook, set by initPanes
let paneChanges = 0;            // transitions, counted

const PANES = ['map', 'settings'];

function getPane(){ return openPane; }
function isPaneOpen(){ return openPane !== null; }

/* Both doors into the drawer, wired in one place.

   The edge tabs are what you see when it is shut; the segmented buttons in the drawer's
   own header are what you see when it is open. They are the same control seen from either
   side, so they call the same function -- with one difference that matters. An edge tab
   TOGGLES (tapping 🗺 twice is a reasonable way to change your mind), while a header tab
   SHOWS (tapping the tab you are already on must not close the drawer out from under you,
   because on a segmented control that reads as a mis-tap, not a decision). */
function initPanes(opts){
  onPaneChange = (opts && opts.onChange) || null;
  document.getElementById('paneTabMap')?.addEventListener('click', ()=> togglePane('map'));
  document.getElementById('paneTabSet')?.addEventListener('click', ()=> togglePane('settings'));
  document.getElementById('paneClose')?.addEventListener('click', ()=> showPane(null));
  document.getElementById('paneSeg')?.addEventListener('click', e=>{
    const b = e.target.closest('button');
    if(b && b.dataset.pane) showPane(b.dataset.pane);
  });
  syncPaneUI();
}

function showPane(name){
  const next = PANES.includes(name) ? name : null;
  if(next === openPane) return;
  openPane = next;
  paneChanges++;
  syncPaneUI();
  if(onPaneChange) onPaneChange(openPane);
}

/* Test seam, same arrangement as minimap.js's getBigView. Switching panes has to be ONE
   transition, not a close followed by an open -- the difference is invisible in the final
   state and very visible on screen, where it is the drawer flinching shut and back. A
   counter is the only thing that can tell the two apart from outside. */
function getPaneChanges(){ return paneChanges; }

function togglePane(name){ showPane(openPane === name ? null : name); }
function closePanes(){ showPane(null); }

/* The attribute is REMOVED rather than set to '' when nothing is open, so `body[data-pane]`
   is a usable "any pane is showing" selector in the stylesheet -- `[data-pane=""]` would
   match an empty string and quietly make every such rule always true. */
function syncPaneUI(){
  const body = document.body;
  if(openPane) body.setAttribute('data-pane', openPane);
  else body.removeAttribute('data-pane');
  document.querySelectorAll('#paneSeg button').forEach(b=>{
    const sel = b.dataset.pane === openPane;
    b.classList.toggle('sel', sel);
    b.setAttribute('aria-selected', sel ? 'true' : 'false');
  });
  setBigMapOpen(openPane === 'map');
}

export { initPanes, getPane, isPaneOpen, showPane, togglePane, closePanes, getPaneChanges };
