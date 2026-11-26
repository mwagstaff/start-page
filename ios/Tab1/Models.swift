import CryptoKit
import Foundation

struct StorySummary: Codable, Hashable {
  struct Thread: Codable, Hashable {
    var bullets: [String]
    var count: Int
    var total: Int
    var updated: String
  }
  var isReady: Bool { recap?.isEmpty == false || discussion?.bullets.isEmpty == false }
  var recap: String?
  var unavailable: Bool?
  var pending: Bool
  var discussion: Thread?
}
struct Story: Codable, Identifiable, Hashable {
  var title: String
  var link: String
  var date: String?
  var image: String?
  var commentsUrl: String?
  var comments: Int?
  var excerpt: String?
  var summary: StorySummary?
  var published: Date? {
    guard let date else { return nil }
    return (try? Date.ISO8601FormatStyle(includingFractionalSeconds: true).parse(date))
      ?? (try? Date.ISO8601FormatStyle().parse(date))
  }
  var source: String?
  var id: String { link }
}
struct Card: Codable, Identifiable {
  var id: String
  var title: String
  var items: [Story]
  var failedSources: [String]?
}
struct Article: Codable {
  var extractionVersion: Int?
  var needsImageUpgrade: Bool { (extractionVersion ?? 0) < 3 }
  var title: String
  var html: String
  var images: [String]
  var downloadedAt: String
}
struct Comment: Codable, Identifiable {
  var id: String
  var parent: String?
  var depth: Int
  var author: String
  var html: String
  var date: String?
}
struct Discussion: Codable {
  var comments: [Comment]
  var total: Int
  var complete: Bool
  var downloadedAt: String
  var savedSummary: String {
    let count = comments.count
    if !complete && total > count { return "\(count) of \(total) comments saved" }
    return count == 1 ? "1 comment saved" : "\(count) comments saved"
  }
  static func updatedLabel(since date: Date, at now: Date) -> String {
    let minutes = Int(now.timeIntervalSince(date) / 60)
    if minutes < 1 { return "Updated just now" }
    if minutes < 60 { return "Updated \(minutes)m ago" }
    let hours = minutes / 60
    if hours < 24 { return "Updated \(hours)h ago" }
    return "Updated \(hours / 24)d ago"
  }
  var updatedDate: Date? {
    (try? Date.ISO8601FormatStyle(includingFractionalSeconds: true).parse(downloadedAt))
      ?? (try? Date.ISO8601FormatStyle().parse(downloadedAt))
  }
  var ordered: [Comment] {
    let ids = Set(comments.map(\.id))
    let groups = Dictionary(grouping: comments, by: { $0.parent ?? "" })
    var result: [Comment] = []
    var seen = Set<String>()
    func append(_ comment: Comment) {
      guard seen.insert(comment.id).inserted else { return }
      result.append(comment)
      for child in groups[comment.id] ?? [] { append(child) }
    }
    for comment in comments where comment.parent == nil || !ids.contains(comment.parent!) {
      append(comment)
    }
    for comment in comments { append(comment) }
    return result
  }
}
struct Reading: Codable {
  var story: Story?
  var read = false
  var saved = false
  enum CodingKeys: String, CodingKey { case story, read, saved }
  init(story: Story? = nil, read: Bool = false, saved: Bool = false) {
    self.story = story
    self.read = read
    self.saved = saved
  }
  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    story = try c.decodeIfPresent(Story.self, forKey: .story)
    read = try c.decodeIfPresent(Bool.self, forKey: .read) ?? false
    saved = try c.decodeIfPresent(Bool.self, forKey: .saved) ?? false
  }
}
struct ReadingPatch: Codable {
  var story: Story?
  var read: Bool?
  var saved: Bool?
}
struct Entry: Codable, Identifiable {
  var story: Story
  var collected: Date = .now
  var article: Article?
  var discussion: Discussion?
  var assets: [String: String] = [:]
  var error: String?
  var failures: [String: String]?
  var retryAfter: [String: Date]?
  var requiredImages: Set<String> { Set((article?.images ?? []) + [story.image].compactMap { $0 }) }
  var ready: Bool {
    article != nil && requiredImages.allSatisfy { assets[$0] != nil }
      && (story.commentsUrl == nil
        || (discussion.map { $0.comments.count >= min($0.total, 500) } ?? false))
  }
  var status: String {
    if let error {
      guard article != nil else { return error }
      return "Article saved · some extras unavailable"
    }
    if ready { return "Ready offline" }
    if article == nil { return "Article waiting to download" }
    if story.commentsUrl != nil && discussion == nil { return "Article saved · comments pending" }
    return "Article saved · images pending"
  }
  var id: String { story.id }
}
struct Library: Codable {
  var cards: [Card] = []
  var entries: [String: Entry] = [:]
  var settings: JSONValue = .object([:])
  var baseline: JSONValue = .object([:])
  var catalogue: JSONValue = .object([:])
  var weather: JSONValue = .null
  var backdrop: JSONValue?
  var backdropFile: String?
  var reading: [String: Reading] = [:]
  var pending: [String: ReadingPatch] = [:]
  var revision = 0
  var updated: Date?
  var lastArticleDownload: Date?
}
struct Snapshot: Decodable {
  var cards: [Card]
  var settings: JSONValue
  var catalogue: JSONValue
  var weather: JSONValue?
  var backdrop: JSONValue?
}
struct SyncResponse: Decodable {
  var signInProvider: String?
  var accountTag: String?
  var token: String?
  var revision: Int
  var settings: JSONValue?
  var reading: [String: Reading]
}
enum JSONValue: Codable, Equatable, Hashable {
  case object([String: JSONValue])
  case array([JSONValue])
  case string(String)
  case number(Double)
  case bool(Bool)
  case null
  init(from decoder: Decoder) throws {
    let c = try decoder.singleValueContainer()
    if c.decodeNil() {
      self = .null
    } else if let v = try? c.decode(Bool.self) {
      self = .bool(v)
    } else if let v = try? c.decode(Double.self) {
      self = .number(v)
    } else if let v = try? c.decode(String.self) {
      self = .string(v)
    } else if let v = try? c.decode([String: JSONValue].self) {
      self = .object(v)
    } else {
      self = .array(try c.decode([JSONValue].self))
    }
  }
  func encode(to encoder: Encoder) throws {
    var c = encoder.singleValueContainer()
    switch self {
    case .object(let v): try c.encode(v)
    case .array(let v): try c.encode(v)
    case .string(let v): try c.encode(v)
    case .number(let v): try c.encode(v)
    case .bool(let v): try c.encode(v)
    case .null: try c.encodeNil()
    }
  }
  var object: [String: JSONValue] {
    if case .object(let v) = self { return v }
    return [:]
  }
  var array: [JSONValue] {
    if case .array(let v) = self { return v }
    return []
  }
  var string: String {
    if case .string(let v) = self { return v }
    return ""
  }
  var number: Double {
    if case .number(let v) = self { return v }
    return 0
  }
  var bool: Bool {
    if case .bool(let v) = self { return v }
    return false
  }
  subscript(_ key: String) -> JSONValue {
    get { object[key] ?? .null }
    set {
      var o = object
      o[key] = newValue
      self = .object(o)
    }
  }
}
func fileID(_ value: String) -> String {
  SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined()
}

func mergePreferences(base: JSONValue, local: JSONValue, remote: JSONValue) -> JSONValue {
  if base == local { return remote }
  if case .object(let b) = base, case .object(let l) = local, case .object(let r) = remote {
    var result = r
    for key in Set(b.keys).union(l.keys) {
      if let value = l[key] {
        result[key] = mergePreferences(base: b[key] ?? .null, local: value, remote: r[key] ?? .null)
      } else {
        result.removeValue(forKey: key)
      }
    }
    return .object(result)
  }
  return local
}

extension Comment {
  // sanitize-html serializes anchor attributes with double quotes.
  private static let anchors = try! NSRegularExpression(
    pattern: #"<a\b[^>]*?\shref="([^"]+)"[^>]*>([\s\S]*?)</a>"#, options: .caseInsensitive)
  private static let detector = try! NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue)

  func linkedText(relativeTo discussionURL: String?) -> AttributedString {
    let source = html.trimmingCharacters(in: .whitespacesAndNewlines)
    let base = discussionURL.flatMap(URL.init(string:))
    var result = AttributedString()
    var cursor = source.startIndex
    func appendPlain(_ fragment: Substring) {
      let plain = htmlText(String(fragment))
      var attributed = AttributedString(plain)
      for match in Self.detector.matches(in: plain, range: NSRange(plain.startIndex..., in: plain)) {
        if let url = match.url, url.isWebLink, let range = Range(match.range, in: plain),
           let span = Range(range, in: attributed) {
          attributed[span].link = url
        }
      }
      result.append(attributed)
    }
    for match in Self.anchors.matches(in: source, range: NSRange(source.startIndex..., in: source)) {
      guard let whole = Range(match.range, in: source),
            let href = Range(match.range(at: 1), in: source),
            let label = Range(match.range(at: 2), in: source) else { continue }
      appendPlain(source[cursor..<whole.lowerBound])
      var anchor = AttributedString(htmlText(String(source[label])))
      if let url = URL(string: htmlText(String(source[href])), relativeTo: base)?.absoluteURL,
         url.isWebLink { anchor.link = url }
      result.append(anchor)
      cursor = whole.upperBound
    }
    appendPlain(source[cursor...])
    let characters = result.characters
    guard let first = characters.firstIndex(where: { !$0.isWhitespace }),
          let last = characters.lastIndex(where: { !$0.isWhitespace }) else { return AttributedString() }
    return AttributedString(result[first...last])
  }
}

private extension URL {
  var isWebLink: Bool { ["https", "http"].contains(scheme?.lowercased() ?? "") && host != nil }
}

private func htmlText(_ html: String) -> String {
  var text = html.replacingOccurrences(
    of: "(?i)<(?:br\\s*/?|/p|/div|/pre|/li)>", with: "\n", options: .regularExpression
  ).replacingOccurrences(of: "<[^>]*>", with: "", options: .regularExpression)
  let entities = [
    "&nbsp;": " ", "&lt;": "<", "&gt;": ">", "&quot;": "\"", "&#39;": "'", "&apos;": "'",
    "&amp;": "&",
  ]
  for (encoded, decoded) in entities {
    text = text.replacingOccurrences(of: encoded, with: decoded)
  }
  if let regex = try? NSRegularExpression(pattern: "&#(x[0-9a-fA-F]+|[0-9]+);") {
    let matches = regex.matches(in: text, range: NSRange(text.startIndex..., in: text))
    for match in matches.reversed() {
      guard let range = Range(match.range, in: text),
        let digits = Range(match.range(at: 1), in: text)
      else { continue }
      let code = String(text[digits])
      let number = code.hasPrefix("x") ? UInt32(code.dropFirst(), radix: 16) : UInt32(code)
      if let number, let scalar = UnicodeScalar(number) {
        text.replaceSubrange(range, with: String(scalar))
      }
    }
  }
  return text
}
