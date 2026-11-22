// Read queue status in batches without promoting jobs or redrawing story cards.
let checking = false;
async function updateButtons() {
  if (checking || document.hidden) return;
  checking = true;
  try {
    const buttons = [...document.querySelectorAll('.summary-link:disabled')];
    for (let start = 0; start < buttons.length; start += 100) {
      const batch = buttons.slice(start, start + 100);
      const response = await fetch('/api/summary-status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(batch.map(button => [button.dataset.story, button.dataset.thread])),
      });
      if (!response.ok) return;
      const states = await response.json();
      batch.forEach((button, index) => {
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
  }
}
updateButtons();
document.querySelector('.grid')?.addEventListener('cards:change', updateButtons);
document.addEventListener('visibilitychange', updateButtons);
setInterval(updateButtons, 15000);

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
