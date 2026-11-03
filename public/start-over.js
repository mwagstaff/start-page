// "Start over" in Settings: after asking, forgets everything saved in this browser (the
// layout, topics & sources, added feeds, page options and the history of changes) and
// reloads the home page, where the setup screen opens as on a first visit. Unlike a
// removed card, this can't be undone, so the dialog says so and offers an export first.

import { startOver } from './page.js';

let dialog = null;
let exportFirst = null; // saves the settings as a file, from Settings

function build() {
  dialog = document.createElement('dialog');
  dialog.className = 'customise remove-dialog start-over';
  dialog.setAttribute('aria-labelledby', 'start-over-title');
  dialog.setAttribute('aria-describedby', 'start-over-about');
  dialog.innerHTML = `
    <h2 id="start-over-title">Start over?</h2>
    <div id="start-over-about">
      <p class="remove-lead">This clears everything saved for your page in this browser and takes you back to the setup screen:</p>
      <ul class="start-over-list">
        <li>Your topics &amp; sources</li>
        <li>Cards you’ve moved, hidden or resized</li>
        <li>Feeds you’ve added</li>
        <li>Density, fill and card options</li>
        <li>Your history of changes</li>
      </ul>
      <p class="start-over-warning"><strong>This can’t be undone.</strong> Export your settings first if you might want them back.</p>
    </div>
    <p class="customise-status" role="status"></p>
    <div class="customise-actions">
      <button type="button" data-action="export">Export first</button>
      <button type="button" data-action="cancel" class="start-over-cancel" autofocus>Cancel</button>
      <button type="button" data-action="confirm" class="danger">Clear &amp; start over</button>
    </div>`;
  document.body.append(dialog);
  dialog.addEventListener('click', (event) => {
    const action = event.target.closest('button[data-action]')?.dataset.action;
    if (action === 'confirm') startOver();
    else if (action === 'cancel') dialog.close();
    else if (action === 'export') {
      exportFirst?.();
      dialog.querySelector('.customise-status').textContent = 'Settings saved as start-page-settings.json.';
    }
  });
  dialog.addEventListener('pointerdown', (event) => { if (event.target === dialog) dialog.close(); });
}

// `onExport` saves the settings as a file, for the "Export first" button.
export function askStartOver({ onExport } = {}) {
  if (!dialog) build();
  exportFirst = onExport;
  dialog.querySelector('.customise-status').textContent = '';
  dialog.showModal();
}
