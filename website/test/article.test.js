import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import { extractArticle } from "../lib/article.js";

// Reduced BBC page: scripts/styles and unrelated layout removed, preserving
// the single article and the adjacent content that makes Readability fail.
test("extracts the BBC taxiway article when the full-page heuristic fails", () => {
  const html = readFileSync(new URL("fixtures/bbc-article-layout.html", import.meta.url), "utf8");
  assert.equal(new Readability(parseHTML(html).document).parse(), null);
  const article = extractArticle(html, "https://www.bbc.co.uk/news/articles/cqx2wnwzmd8mo");
  assert.match(article.title, /British Airways/);
  assert.match(article.html, /taxiway/);
  assert.match(article.html, /passengers/i);
  assert.doesNotMatch(article.html, /<script|<button|Related stories/i);
});

test("keeps readable text, resolves URLs, and strips scripts and unsafe attributes", () => {
  const html = `<html><head><title>Test article</title></head><body><article>
    <h1>Test article</h1><p>${"A detailed report, with background and context for readers. ".repeat(20)}</p>
    <img src="/photo.jpg" onerror="alert(1)"><a href="/more">More information</a>
    <script>alert(1)</script><a href="javascript:alert(1)">Unsafe link</a>
    </article></body></html>`;
  const article = extractArticle(html, "https://example.org/news/story");
  assert.match(article.html, /A detailed report/);
  assert.deepEqual(article.images, ["https://example.org/photo.jpg"]);
  assert.match(article.html, /https:\/\/example.org\/more/);
  assert.doesNotMatch(article.html, /onerror|javascript:|<script/);
});

test("empty and hidden articles report a permanent extraction failure", () => {
  for (const html of ["<html><body>Unavailable</body></html>",
    `<html><body><section hidden><article><p>${"Hidden content. ".repeat(100)}</p></article></section></body></html>`]) {
    assert.throws(() => extractArticle(html, "https://example.org/story"),
      error => error.status === 422 && error.retryable === false);
  }
});

test("preserves lead and inline editorial figures, captions and Unicode, excluding promos", () => {
  const paragraph = "The reporter’s account describes the café, with £20 tickets and a clear explanation. ".repeat(8);
  const html = `<html><head><title>A reporter’s café report</title></head><body><article>
    <div class="media"><figure><picture><source srcset="/lead.webp 800w"><img src="/lead.jpg" alt="Lead photograph"></picture><figcaption>Photograph: José</figcaption></figure></div>
    <div class="article-body"><p>${paragraph}</p>
    <figure><img data-src="/inline.jpg" src="data:image/gif;base64,placeholder"><figcaption>Inside the café</figcaption></figure>
    <p>Second section. ${paragraph}</p></div>
    <aside><figure><img src="/advert.jpg"></figure></aside>
    <div data-testid="promo"><figure><img src="/related.jpg"></figure></div>
    </article></body></html>`;
  const result = extractArticle(html, "https://example.org/story");
  assert.equal(result.extractionVersion, 3);
  assert.deepEqual(result.images.sort(), ["https://example.org/inline.jpg", "https://example.org/lead.jpg"]);
  assert.match(result.html, /Photograph: José/);
  assert.match(result.html, /reporter’s account/);
  assert.ok(result.html.indexOf("inline.jpg") < result.html.indexOf("Second section"));
  assert.doesNotMatch(result.html, /srcset|data:image|advert.jpg|related.jpg/);
});

test("live-blog timeline is compact and jumps to retained offline blocks", () => {
  const url = "https://example.org/live/story";
  const text = "This is a detailed update, explaining the events and providing useful context. ".repeat(12);
  const html = `<html><head><title>Live updates</title></head><body><main>
    <h2>Key events</h2><ul><li><a href="?page=with:block-first#block-first"><p><time>1m ago</time></p><p>First event</p></a></li>
    <li><a href="?page=with:block-last#block-last"><p><time>5m ago</time></p><p>Last event</p></a></li></ul>
    <article id="block-first"><h2>First event</h2><p>${text}</p></article>
    <article id="block-last"><h2>Last event</h2><p>${text}</p></article></main></body></html>`;
  const result = extractArticle(html, url);
  assert.match(result.html, /class="reader-timeline"/);
  assert.match(result.html, /href="#block-first"/);
  assert.match(result.html, /<span class="reader-time">1m ago<\/span><span>First event<\/span>/);
  const block = parseHTML(result.html).document.querySelector("#block-last");
  assert.equal(block.getAttribute("class"), "reader-block");
  assert.doesNotMatch(result.html, /page=with/);
});
