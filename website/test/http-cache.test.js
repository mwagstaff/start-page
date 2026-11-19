import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, get } from 'node:http';
import { once } from 'node:events';
import { gzipSync } from 'node:zlib';
import { matchesIfNoneMatch, notModified } from '../lib/http-cache.js';

test('If-None-Match compares weak tags, lists, wildcard and quoted commas', () => {
  for (const header of ['"abc"', 'W/"abc"', '"older", W/"abc"', '*', ' , W/"abc", ']) {
    assert.equal(matchesIfNoneMatch(header, '"abc"'), true, header);
  }
  assert.equal(matchesIfNoneMatch('"abc"', 'W/"abc"'), true);
  assert.equal(matchesIfNoneMatch('"other", W/"a,b"', '"a,b"'), true);
  for (const header of [undefined, '', '"ABC"', '"old"', 'abc', 'garbage "abc"', '"abc" garbage', '*, "abc"', '"unterminated']) {
    assert.equal(matchesIfNoneMatch(header, '"abc"'), false, String(header));
  }
});

test('conditional GET and HEAD work through a proxy that weakens compressed ETags', async (t) => {
  const origin = createServer((req, res) => {
    if (notModified(req, res, '"version"', 'public, max-age=60')) return;
    res.end('snapshot');
  });
  origin.listen(0, '127.0.0.1');
  await once(origin, 'listening');
  t.after(() => origin.close());
  const proxy = createServer((req, res) => {
    const upstream = get({ hostname: '127.0.0.1', port: origin.address().port, method: req.method, headers: req.headers }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const headers = { ...response.headers, vary: 'Accept-Encoding' };
        delete headers['content-length'];
        delete headers['transfer-encoding'];
        if (response.statusCode === 200 && req.method !== 'HEAD') {
          headers.etag = `W/${headers.etag}`;
          headers['content-encoding'] = 'gzip';
          res.writeHead(200, headers);
          res.end(gzipSync(Buffer.concat(chunks)));
        } else {
          res.writeHead(response.statusCode, headers);
          res.end();
        }
      });
    });
    upstream.on('error', () => { res.writeHead(502); res.end(); });
  });
  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  t.after(() => proxy.close());
  const url = `http://127.0.0.1:${proxy.address().port}`;
  const first = await fetch(url);
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('etag'), 'W/"version"');
  assert.equal(await first.text(), 'snapshot');
  for (const method of ['GET', 'HEAD']) {
    const response = await fetch(url, { method, headers: { 'If-None-Match': first.headers.get('etag') } });
    assert.equal(response.status, 304);
    assert.equal(await response.text(), '');
    assert.equal(response.headers.get('cache-control'), 'public, max-age=60');
  }
  const changed = await fetch(url, { headers: { 'If-None-Match': 'W/"old"' } });
  assert.equal(changed.status, 200);
  assert.equal(await changed.text(), 'snapshot');
});
