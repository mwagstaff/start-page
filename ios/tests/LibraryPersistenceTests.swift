import Foundation

@main struct LibraryPersistenceTests {
  static func main() async throws {
    let root = URL.temporaryDirectory.appending(path: UUID().uuidString)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }
    let file = root.appending(path: "library.json")
    let writer = LibraryPersistence()
    var library = Library()
    for index in 0..<500 {
      library.revision = index
      writer.save(library, to: file) { error in fatalError(error) }
    }
    await writer.flush()
    let saved = try JSONDecoder().decode(Library.self, from: Data(contentsOf: file))
    precondition(saved.revision == 499)
    library.revision = 500
    writer.save(library, to: file) { error in fatalError(error) }
    await writer.flush()
    let latest = try JSONDecoder().decode(Library.self, from: Data(contentsOf: file))
    precondition(latest.revision == 500)
    print("Coalesced library save and flush checks passed")
  }
}
