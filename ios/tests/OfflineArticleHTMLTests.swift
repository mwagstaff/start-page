import Foundation

@main struct OfflineArticleHTMLTests {
  static func main() throws {
    let html = offlineArticleHTML(
      title: "Journalist’s café\u{00a0}report",
      content:
        "<p>José — £20 “quoted”.</p><img src=\"https://example.org/photo?w=800&amp;x=1\"><a href=\"https://example.org/photo?w=800&amp;x=1\">Photo source</a>",
      assets: ["https://example.org/photo?w=800&x=1": "cached.image"],
      original: "https://example.org/story?a=1&b=2")
    precondition(html.contains("<head><meta charset=\"utf-8\">"))
    precondition(html.contains("Journalist’s café\u{00a0}report"))
    precondition(html.contains("José — £20 “quoted”."))
    precondition(html.contains("src=\"cached.image\""))
    precondition(html.contains("href=\"https://example.org/photo?w=800&amp;x=1\""))
    precondition(
      html.contains(
        "<footer><a href=\"https://example.org/story?a=1&amp;b=2\">Open original in browser</a></footer>"
      ))
    precondition(html.contains("img-src file:"))
    precondition(
      !offlineArticleHTML(
        title: "<script>", content: "", assets: [:], original: "javascript:alert(1)"
      ).contains("<footer>"))
    let old = try JSONDecoder().decode(Article.self, from: Data(#"{"title":"Saved","html":"<p>Keep me offline</p>","images":[],"downloadedAt":"yesterday"}"#.utf8))
    precondition(old.needsImageUpgrade && old.html.contains("Keep me offline"))
    var upgraded = old
    upgraded.extractionVersion = 3
    precondition(!upgraded.needsImageUpgrade)
    print("Offline HTML and legacy article checks passed")
  }
}
