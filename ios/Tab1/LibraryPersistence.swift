import Foundation

// Serial, coalesced writes keep large libraries off the UI thread. flush() is
// used before acknowledging background URLSession events to iOS.
final class LibraryPersistence: @unchecked Sendable {
  private let queue = DispatchQueue(label: "tab1.library-writes", qos: .utility)
  private let lock = NSLock()
  private var pending: (Library, URL, @Sendable (String) -> Void, (@Sendable (Date) -> Void)?)?
  private var running = false

  func save(_ library: Library, to file: URL, onSaved: (@Sendable (Date) -> Void)? = nil, onError: @escaping @Sendable (String) -> Void) {
    lock.lock()
    pending = (library, file, onError, onSaved)
    let start = !running
    running = true
    lock.unlock()
    if start { queue.async { self.drain() } }
  }
  private func drain() {
    while true {
      lock.lock()
      guard let next = pending else {
        running = false
        lock.unlock()
        return
      }
      pending = nil
      lock.unlock()
      do {
        try JSONEncoder().encode(next.0).write(to: next.1, options: .atomic)
        next.3?(.now)
      } catch {
        next.2(error.localizedDescription)
      }
    }
  }
  func flush() async {
    await withCheckedContinuation { continuation in
      queue.async {
        self.drain()
        continuation.resume()
      }
    }
  }
}
