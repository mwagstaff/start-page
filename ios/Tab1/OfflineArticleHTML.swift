import Foundation

func escapedHTML(_ value: String) -> String {
  value.replacingOccurrences(of: "&", with: "&amp;")
    .replacingOccurrences(of: "\"", with: "&quot;")
    .replacingOccurrences(of: "<", with: "&lt;")
    .replacingOccurrences(of: ">", with: "&gt;")
}

func offlineArticleHTML(title: String, content: String, assets: [String: String], original: String)
  -> String
{
  var body = content
  // One pass over image tags, rather than scanning the whole article once per asset.
  if let tags = try? NSRegularExpression(pattern: "<img\\b[^>]*>", options: .caseInsensitive),
    let sources = try? NSRegularExpression(pattern: "src=\"([^\"]*)\"", options: .caseInsensitive)
  {
    let matches = tags.matches(in: body, range: NSRange(body.startIndex..., in: body))
    for match in matches.reversed() {
      guard let range = Range(match.range, in: body) else { continue }
      var tag = String(body[range])
      if let source = sources.firstMatch(in: tag, range: NSRange(tag.startIndex..., in: tag)),
        let valueRange = Range(source.range(at: 1), in: tag)
      {
        let remote = String(tag[valueRange]).replacingOccurrences(of: "&amp;", with: "&")
        if let file = assets[remote] { tag.replaceSubrange(valueRange, with: escapedHTML(file)) }
      }
      tag = tag.replacingOccurrences(of: "<img", with: "<img loading=\"lazy\" decoding=\"async\"")
      body.replaceSubrange(range, with: tag)
    }
  }
  let footer: String
  if let url = URL(string: original), ["https", "http"].contains(url.scheme?.lowercased() ?? "") {
    footer = "<footer><a href=\"\(escapedHTML(original))\">Open original in browser</a></footer>"
  } else {
    footer = ""
  }
  return """
    <!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src file:; style-src 'unsafe-inline'"><style>:root{color-scheme:light dark}body{font:-apple-system-body;margin:24px;line-height:1.6;overflow-wrap:anywhere}h1{font:-apple-system-title1;font-weight:700}img{max-width:100%;height:auto;border-radius:8px}figure{margin:24px 0;content-visibility:auto;contain-intrinsic-size:auto 320px}.reader-block{content-visibility:auto;contain-intrinsic-size:auto 600px;scroll-margin-top:16px}.reader-timeline{list-style:none;padding:0;margin:16px 0 28px}.reader-timeline li{margin:0;border-bottom:1px solid gray;padding:10px 0}.reader-timeline a{display:grid;grid-template-columns:minmax(5em,auto) 1fr;gap:12px;text-decoration:none}.reader-time{font:-apple-system-caption1;font-weight:600}.reader-timeline p{margin:0}li>p{margin:.3em 0}li>a>p{margin:.3em 0}figcaption{font:-apple-system-caption1;color:gray;margin-top:8px}footer{border-top:1px solid gray;margin-top:32px;padding:24px 0}footer a{display:inline-block;padding:8px 0}pre{overflow:auto}table{max-width:100%;display:block;overflow:auto}a{color:#6366f1}</style></head><body><h1>\(escapedHTML(title))</h1>\(body)\(footer)</body></html>
    """
}
