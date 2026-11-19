// GET/HEAD cache validation uses weak comparison: compression proxies may turn
// "version" into W/"version" without changing the underlying representation.
export function matchesIfNoneMatch(header, etag) {
  if (typeof header !== 'string') return false;
  if (header.trim() === '*') return true;
  const tags = [];
  let rest = header.trim();
  while (rest) {
    // Empty list members are allowed. Commas inside quoted tags are not separators.
    if (rest.startsWith(',')) { rest = rest.slice(1).trimStart(); continue; }
    const match = rest.match(/^((?:W\/)?"[\x21\x23-\x7e\x80-\xff]*")[ \t]*(?:,|$)/);
    if (!match) return false;
    tags.push(match[1].replace(/^W\//, ''));
    rest = rest.slice(match[0].length).trimStart();
  }
  return tags.includes(etag.replace(/^W\//, ''));
}

export function notModified(req, res, etag, cacheControl) {
  res.setHeader('ETag', etag);
  res.setHeader('Cache-Control', cacheControl);
  if (!['GET', 'HEAD'].includes(req.method) || !matchesIfNoneMatch(req.headers['if-none-match'], etag)) return false;
  res.writeHead(304);
  res.end();
  return true;
}
