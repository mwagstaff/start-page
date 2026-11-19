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
  if (!button) return;
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
