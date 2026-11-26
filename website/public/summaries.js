// Read queue status in batches without promoting jobs or redrawing story cards.
let checking = false;
let refreshRequested = false;
let lastFullCheck = -Infinity;
async function updateButtons(fullCheck) {
  if (document.hidden) return;
  if (checking) {
    if (fullCheck) refreshRequested = true;
    return;
  }
  checking = true;
  try {
    if (fullCheck) lastFullCheck = performance.now();
    const buttons = [...document.querySelectorAll(fullCheck
      ? '.summary-link:disabled' : '.summary-link:disabled[data-state="pending"]')];
    for (let start = 0; start < buttons.length; start += 100) {
      if (document.hidden || refreshRequested) break;
      const batch = buttons.slice(start, start + 100);
      const response = await fetch('/api/summary-status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(batch.map(button => [button.dataset.story, button.dataset.thread])),
      });
      if (!response.ok) return;
      const states = await response.json();
      batch.forEach((button, index) => {
        if (!button.isConnected) return;
        const state = states[index];
        button.dataset.state = state;
        button.disabled = state !== 'ready';
        button.title = state === 'pending' ? 'Preparing summary automatically'
          : state === 'unavailable' ? 'Summary unavailable' : 'Open summary';
        button.setAttribute('aria-label', button.title + ' · ' + button.closest('.body').querySelector('.headline').textContent);
      });
    }
  } catch {
    // Retry transient connection failures on the next check.
  } finally {
    checking = false;
    if (refreshRequested) {
      refreshRequested = false;
      updateButtons(true);
    }
  }
}
const refreshButtons = () => updateButtons(true);
refreshButtons();
document.querySelector('.grid')?.addEventListener('cards:change', refreshButtons);
document.addEventListener('visibilitychange', refreshButtons);
// Poll spinning buttons frequently. Unavailable stories can recover on a later worker pass.
setInterval(() => updateButtons(performance.now() - lastFullCheck >= 15000), 5000);

async function show(button, panel) {
  const params = new URLSearchParams({ url: button.dataset.story, thread: button.dataset.thread });
  try {
    const response = await fetch('/api/summary?' + params);
    if (!response.ok) throw new Error();
    const data = await response.json();
    if (!panel.isConnected) return;
    panel.replaceChildren();
    function line(tag, value) {
      const node = document.createElement(tag);
      node.textContent = value;
      panel.append(node);
    }
    const excerpt = data.unavailable && button.dataset.excerpt;
    if (data.recap || excerpt) {
      line('strong', data.recap ? 'AI story summary' : 'Publisher excerpt');
      line('p', data.recap || excerpt);
    } else if (data.unavailable) line('p', 'Article text unavailable.');
    if (data.discussion) {
      line('strong', 'AI discussion summary');
      const list = document.createElement('ul');
      for (const bullet of data.discussion.bullets) {
        const item = document.createElement('li');
        item.textContent = bullet;
        list.append(item);
      }
      panel.append(list);
      line(
        'small',
        `Based on ${data.discussion.count} of ${data.discussion.total} comments · ${new Date(data.discussion.updated).toLocaleString()}`,
      );
    }
    if (data.pending) {
      line('p', 'Preparing summary…');
      setTimeout(() => {
        if (panel.isConnected) show(button, panel);
      }, 8000);
    }
  } catch {
    panel.textContent = 'Couldn’t load the summary. Reopen to retry.';
  }
}
document.addEventListener('click', (event) => {
  const button = event.target.closest('.summary-link');
  if (!button || button.disabled) return;
  const body = button.closest('.body');
  const existing = body.querySelector('.story-summary');
  button.setAttribute('aria-expanded', String(!existing));
  if (existing) {
    existing.remove();
    return;
  }
  const panel = document.createElement('section');
  panel.className = 'story-summary';
  panel.textContent = 'Loading summary…';
  body.append(panel);
  show(button, panel);
});
