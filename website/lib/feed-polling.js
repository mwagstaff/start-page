// Fixed slots keep each feed on its own ten-minute clock, even when a request is slow.
export function staggerPolls(entries, interval, poll) {
  entries.forEach((entry, index) => {
    const offset = Math.round(interval * (index + 0.5) / entries.length);
    const run = () => Promise.resolve().then(() => poll(entry)).catch(error => console.warn('Feed poll:', error.message));
    setTimeout(() => {
      setInterval(run, interval).unref();
      run();
    }, offset).unref();
  });
}

export function validatorHeaders(previous) {
  const headers = {};
  if (previous?.etag) headers['If-None-Match'] = previous.etag;
  if (previous?.modified) headers['If-Modified-Since'] = previous.modified;
  return headers;
}
