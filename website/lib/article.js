import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import sanitize from "sanitize-html";

function visible(node) {
  for (; node; node = node.parentElement) {
    if (node.hasAttribute("hidden") || node.getAttribute("aria-hidden") === "true"
      || /(?:display\s*:\s*none|visibility\s*:\s*hidden)/i.test(node.getAttribute("style") || "")) return false;
  }
  return true;
}
const textKey = node => node.textContent.replace(/\s+/g, " ").trim();

// Capture editorial figures before Readability drops image-only layout blocks.
// Paragraph anchors let us put an inline figure back in its original position.
function editorialFigures(document) {
  const articles = document.querySelectorAll("article");
  if (articles.length !== 1) return [];
  const nodes = [...articles[0].querySelectorAll("figure, p")];
  return nodes.flatMap((node, index) => {
    if (node.tagName !== "FIGURE" || !visible(node)
      || node.closest('aside, nav, footer, [role="complementary"], [data-testid="promo"], [data-component="related-links"]')) return [];
    const images = [...node.querySelectorAll("img[src]")].filter(visible);
    if (!images.length) return [];
    const figure = document.createElement("figure");
    for (const image of images) figure.append(image.cloneNode(true));
    const caption = node.querySelector("figcaption");
    if (caption) figure.append(caption.cloneNode(true));
    const following = nodes.slice(index + 1).filter(n => n.tagName === "P" && !n.closest("figure")).map(textKey);
    const preceding = nodes.slice(0, index).filter(n => n.tagName === "P" && !n.closest("figure")).map(textKey).reverse();
    return [{ html: figure.outerHTML, following, preceding, lead: preceding.length === 0 }];
  });
}

export function extractArticle(html, link) {
  const { document } = parseHTML(html);
  for (const img of document.querySelectorAll("img")) {
    const lazy = img.getAttribute("data-src") || img.getAttribute("data-original");
    const srcset = img.getAttribute("data-srcset") || img.getAttribute("srcset") || img.getAttribute("srcSet")
      || img.closest("picture")?.querySelector("source")?.getAttribute("srcset");
    const candidate = srcset?.split(/,\s+(?=https?:|\/)/).map(s => s.trim().split(/\s+/)[0]).filter(Boolean).pop();
    if (lazy || !img.getAttribute("src") || img.getAttribute("src").startsWith("data:")) {
      if (lazy || candidate) img.setAttribute("src", lazy || candidate);
    }
    // The offline reader uses one downloaded source, never a remote srcset.
    img.removeAttribute("srcset");
    img.removeAttribute("srcSet");
  }
  for (const el of document.querySelectorAll("[src], [href]")) {
    for (const attr of ["src", "href"]) {
      if (!el.hasAttribute(attr)) continue;
      try { el.setAttribute(attr, new URL(el.getAttribute(attr), link).href); }
      catch { el.removeAttribute(attr); }
    }
  }
  // Readability can discard an entire story because a layout ancestor's class
  // contains "Sidebar" (BBC's ContainerWithSidebarWrapper, for example).
  // Keep a fresh, narrowly scoped document: Readability mutates its input.
  const figures = editorialFigures(document);
  const timeline = [...document.querySelectorAll("ul, ol")].find(list =>
    list.querySelector('a[href*="#block-"] time'))?.cloneNode(true);
  const articles = document.querySelectorAll("article");
  let scoped;
  if (articles.length === 1 && visible(articles[0])) {
    scoped = document.cloneNode(true);
    scoped.body.replaceChildren(scoped.querySelector("article"));
  }
  let article = new Readability(document).parse();
  if ((!article || article.textContent.trim().length < 120) && scoped) {
    article = new Readability(scoped).parse();
  }
  if (!article || article.textContent.trim().length < 120) {
    throw Object.assign(new Error("This publisher’s article could not be saved. Open the publisher website to read it."), {
      status: 422, retryable: false,
    });
  }
  const { document: extracted } = parseHTML(`<html><body>${article.content}</body></html>`);
  for (const saved of figures.reverse()) {
    const { document: fragment } = parseHTML(saved.html);
    const figure = fragment.querySelector("figure");
    const existing = new Set([...extracted.querySelectorAll("img")].map(i => i.getAttribute("src")));
    for (const img of [...figure.querySelectorAll("img")]) if (existing.has(img.getAttribute("src"))) img.remove();
    if (!figure.querySelector("img")) continue;
    const paragraphs = [...extracted.querySelectorAll("p")];
    const following = saved.following.map(key => paragraphs.find(p => textKey(p) === key)).find(Boolean);
    const preceding = saved.preceding.map(key => paragraphs.find(p => textKey(p) === key)).find(Boolean);
    if (following) following.before(figure);
    else if (preceding) preceding.after(figure);
    else if (saved.lead) extracted.body.prepend(figure);
  }
  // Retain local live-blog targets and turn the publisher carousel into a
  // semantic, compact list. Never point a saved timeline back at the network.
  const targets = new Set();
  for (const block of extracted.querySelectorAll('[id^="block-"]')) {
    if (!/^block-[a-zA-Z0-9_-]+$/.test(block.id)) continue;
    targets.add(block.id);
    block.setAttribute("class", "reader-block");
  }
  if (timeline && targets.size && !extracted.querySelector('li a[href*="#block-"] time')) {
    for (const item of [...timeline.children]) {
      const href = item.querySelector("a[href]")?.getAttribute("href");
      if (!href || !targets.has(new URL(href, link).hash.slice(1))) item.remove();
    }
    if (timeline.children.length) {
      const heading = extracted.createElement("h2");
      heading.textContent = "Key events";
      extracted.body.prepend(heading, timeline);
    }
  }
  for (const anchor of extracted.querySelectorAll("a[href]")) {
    try {
      const target = new URL(anchor.getAttribute("href"), link);
      const source = new URL(link);
      if (target.origin === source.origin && target.pathname === source.pathname && targets.has(target.hash.slice(1))) {
        anchor.setAttribute("href", target.hash);
        const item = anchor.closest("li");
        const list = item?.parentElement;
        if (list && ["UL", "OL"].includes(list.tagName) && anchor.querySelector("time")) {
          list.setAttribute("class", "reader-timeline");
          const time = anchor.querySelector("time");
          const label = [...anchor.querySelectorAll("p")].filter(p => !p.contains(time)).map(textKey).join(" ");
          if (label) {
            const stamp = extracted.createElement("span");
            stamp.setAttribute("class", "reader-time");
            stamp.textContent = time.textContent;
            const heading = extracted.createElement("span");
            heading.textContent = label;
            anchor.replaceChildren(stamp, heading);
          }
        }
      }
    } catch { /* Leave other links for the regular sanitizer. */ }
  }
  const content = sanitize(extracted.body.innerHTML, {
    allowedTags: sanitize.defaults.allowedTags.concat(["img", "figure", "figcaption"]),
    allowedAttributes: { ...sanitize.defaults.allowedAttributes, img: ["src", "alt", "width", "height"], a: ["href"], "*": ["id", "class"] },
    allowedClasses: { "*": ["reader-block", "reader-timeline", "reader-time"] },
    allowedSchemes: ["https", "http"],
  });
  const { document: clean } = parseHTML(content);
  return {
    extractionVersion: 3,
    title: article.title,
    html: content,
    images: [...new Set([...clean.querySelectorAll("img")].map(i => i.getAttribute("src")).filter(Boolean))],
    downloadedAt: new Date().toISOString(),
  };
}
