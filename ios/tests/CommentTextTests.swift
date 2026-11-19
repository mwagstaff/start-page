import Foundation

@main struct CommentTextTests {
  static func main() {
    let comment = Comment(id: "1", depth: 0, author: "a", html: """
      <p>📚 <a href="/read?a=1&amp;b=2"><i>source</i></a> and https://example.org/guide.</p><p><a href="javascript:void(0)">skip</a></p>
      """)
    let text = comment.linkedText(relativeTo: "https://news.ycombinator.com/item?id=1")
    precondition(String(text.characters) == "📚 source and https://example.org/guide.\nskip")
    precondition(text.runs.compactMap { $0.link?.absoluteString } == [
      "https://news.ycombinator.com/read?a=1&b=2", "https://example.org/guide",
    ])
    let date = Date.now
    for (seconds, label) in [(59, "Updated just now"), (300, "Updated 5m ago"),
                             (7_200, "Updated 2h ago"), (86_400, "Updated 1d ago")] {
      precondition(Discussion.updatedLabel(since: date, at: date.addingTimeInterval(Double(seconds))) == label)
    }
    var discussion = Discussion(comments: [comment], total: 0, complete: true, downloadedAt: "")
    precondition(discussion.savedSummary == "1 comment saved")
    discussion.complete = false
    discussion.total = 3
    precondition(discussion.savedSummary == "1 of 3 comments saved")
  }
}
