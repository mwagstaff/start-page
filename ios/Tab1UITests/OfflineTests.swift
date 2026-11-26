import XCTest

final class LiveAccountTests: XCTestCase {
  private func launchLiveApp(accountMarker: Bool = false) throws -> XCUIApplication {
    try XCTSkipUnless(ProcessInfo.processInfo.environment["TAB1_LIVE_ACCOUNT"] == "1",
                      "Set TEST_RUNNER_TAB1_LIVE_ACCOUNT=1 to check the deployed provider configuration.")
    let app = XCUIApplication()
    app.launchArguments = ["--ui-testing", "--reset-ui-library", "-server", "https://tab1.net", "-automatic", "NO"]
    if accountMarker { app.launchArguments += ["-tab1.accountActive", "YES"] }
    app.launch()
    return app
  }
  func testSignOutFromHomeMenu() throws {
    let app = try launchLiveApp(accountMarker: true)
    let menu = app.buttons["Account menu"]
    XCTAssertTrue(menu.waitForExistence(timeout: 20))
    menu.tap()
    XCTAssertTrue(app.buttons["Account settings"].exists)
    app.buttons["Sign out"].tap()
    let profile = app.buttons["Sign in or create an account"]
    XCTAssertTrue(profile.waitForExistence(timeout: 30))
    profile.tap()
    XCTAssertTrue(app.buttons["Continue with Google"].waitForExistence(timeout: 15))
    XCTAssertFalse(app.buttons["Clear signed-out account"].exists)
  }
  func testExpiredSessionReturnsToProvidersInSettings() throws {
    let app = try launchLiveApp(accountMarker: true)
    let menu = app.buttons["Account menu"]
    XCTAssertTrue(menu.waitForExistence(timeout: 20))
    menu.tap()
    app.buttons["Account settings"].tap()
    XCTAssertTrue(app.navigationBars["Account"].exists)
    XCTAssertTrue(app.buttons["Continue with Google"].waitForExistence(timeout: 30))
    XCTAssertTrue(app.buttons["account-apple"].exists)
    XCTAssertFalse(app.buttons["Clear signed-out account"].exists)
  }
  func testQRPairingAvailable() throws {
    let app = try launchLiveApp()
    let settings = app.tabBars.buttons["Settings"]
    XCTAssertTrue(settings.waitForExistence(timeout: 15))
    settings.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
    XCTAssertTrue(app.buttons["Connect website"].isEnabled)
    XCTAssertTrue(app.buttons["Account"].exists)
  }
  func testHomeSignInPopover() throws {
    let app = try launchLiveApp()
    let profile = app.buttons["Sign in or create an account"]
    XCTAssertTrue(profile.waitForExistence(timeout: 15))
    XCTAssertTrue(profile.isHittable)
    profile.tap()
    let google = app.buttons["Continue with Google"]
    XCTAssertTrue(google.waitForExistence(timeout: 45))
    XCTAssertTrue(google.isEnabled)
    XCTAssertFalse(app.navigationBars["Account"].exists)
    XCTAssertLessThan(google.frame.maxY, app.frame.midY)
    let apple = app.buttons["account-apple"]
    XCTAssertTrue(apple.waitForExistence(timeout: 10))
    XCTAssertEqual(apple.frame.height, google.frame.height, accuracy: 1)
    XCTAssertEqual(apple.frame.width, google.frame.width, accuracy: 1)
    let ready = XCTNSPredicateExpectation(predicate: NSPredicate(format: "enabled == true"), object: apple)
    XCTAssertEqual(XCTWaiter.wait(for: [ready], timeout: 15), .completed)
  }
}

final class OfflineTests: XCTestCase {
  override func setUp() {
    super.setUp()
    continueAfterFailure = false
  }
  private func configureDownloads(failures: Int, status: Int, long: Bool = false) throws {
    XCUIApplication().terminate()
    let done = expectation(description: "Configure downloads")
    var request = URLRequest(url: URL(string: "http://localhost:3068/test/downloads")!)
    request.httpMethod = "POST"
    request.httpBody = try JSONSerialization.data(withJSONObject: [
      "failures": failures, "status": status, "long": long,
    ])
    URLSession.shared.dataTask(with: request) { _, response, error in
      XCTAssertNil(error)
      XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
      done.fulfill()
    }.resume()
    wait(for: [done], timeout: 10)
  }
  private func launchReader(server: String = "http://localhost:3068", extraArguments: [String] = []) -> XCUIApplication {
    let app = XCUIApplication()
    app.launchArguments = [
      "--ui-testing", "--reset-ui-library", "-server", server, "-automatic", "NO",
    ]
    app.launchArguments += extraArguments
    app.launch()
    let headline = app.staticTexts["A story ready for the journey"]
    XCTAssertTrue(headline.waitForExistence(timeout: 45))
    headline.firstMatch.tap()
    return app
  }
  func testPendingSummaryEnablesAutomaticallyInReader() {
    let app = launchReader(server: "http://localhost:3068/pending-summary")
    let pending = app.buttons["Summary"].firstMatch
    XCTAssertTrue(pending.waitForExistence(timeout: 5))
    XCTAssertFalse(pending.isEnabled)
    let ready = app.segmentedControls.buttons["Summary"]
    XCTAssertTrue(ready.waitForExistence(timeout: 30))
    ready.tap()
    XCTAssertTrue(app.staticTexts["AI discussion summary"].waitForExistence(timeout: 5))
  }
  func testPublisherExcerptAndDiscussionOffline() throws {
    let app = launchReader(extraArguments: ["-AppleInterfaceStyle", "Dark",
      "-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXL"])
    app.segmentedControls.buttons["Summary"].tap()
    XCTAssertTrue(app.staticTexts["Publisher excerpt"].waitForExistence(timeout: 10))
    app.terminate()
    app.launchArguments = ["--ui-testing", "-server", "http://localhost:9", "-automatic", "NO"]
    app.launch()
    let summary = app.buttons["Summary"].firstMatch
    XCTAssertTrue(summary.waitForExistence(timeout: 20))
    summary.tap()
    XCTAssertTrue(app.staticTexts["The publisher’s original words."].waitForExistence(timeout: 10))
    XCTAssertTrue(app.staticTexts["• Readers compared the two routes."].exists)
  }
  func testTemporaryFailureRetriesAutomatically() throws {
    try configureDownloads(failures: 1, status: 503)
    let app = launchReader()
    app.buttons["retry-download"].tap()
    XCTAssertTrue(app.staticTexts["Retry queued automatically…"].waitForExistence(timeout: 20))
    XCTAssertTrue(app.webViews.firstMatch.waitForExistence(timeout: 120))
    XCTAssertFalse(app.staticTexts["Fixture article unavailable"].exists)
  }
  func testDownloadProgressAcrossTabs() throws {
    try configureDownloads(failures: 2, status: 503)
    let app = launchReader(extraArguments: [
      "-AppleInterfaceStyle", "Dark", "-UIPreferredContentSizeCategoryName",
      "UICTContentSizeCategoryAccessibilityXXL",
    ])
    app.buttons["retry-download"].tap()
    app.navigationBars.buttons.firstMatch.tap()
    let progress = app.descendants(matching: .any)["download-progress"].firstMatch
    XCTAssertTrue(progress.waitForNonExistence(timeout: 10))
    XCTAssertTrue(app.staticTexts["cards-updated"].label.contains("0 downloaded · 1 pending"))
    app.tabBars.buttons["Downloads"].tap()
    let queued = app.descendants(matching: .any)["queued-retries"].firstMatch
    XCTAssertTrue(queued.waitForExistence(timeout: 10))
    XCTAssertEqual(queued.label, "1 file queued for automatic retry")
    XCTAssertFalse(progress.exists)
    XCTAssertTrue(progress.waitForExistence(timeout: 120))
    let complete = XCTNSPredicateExpectation(
      predicate: NSPredicate(format: "label == %@ AND value == %@", "Downloads complete", "3 of 3 downloaded"),
      object: progress)
    XCTAssertEqual(XCTWaiter.wait(for: [complete], timeout: 120), .completed)
    app.tabBars.buttons["Home"].tap()
    XCTAssertFalse(progress.exists)
    XCTAssertTrue(app.staticTexts["cards-updated"].label.contains("1 downloaded · last just now"))
  }
  func testPermanentFailureHasManualRetry() throws {
    try configureDownloads(failures: 1, status: 422)
    let app = launchReader(extraArguments: [
      "-AppleInterfaceStyle", "Dark", "-UIPreferredContentSizeCategoryName",
      "UICTContentSizeCategoryXXXL",
    ])
    app.buttons["retry-download"].tap()
    let retry = app.buttons["Retry download"]
    XCTAssertTrue(retry.waitForExistence(timeout: 20))
    XCTAssertTrue(app.staticTexts["Fixture article unavailable"].exists)
    XCTAssertTrue(retry.isHittable)
    let screenshot = XCTAttachment(screenshot: app.screenshot())
    screenshot.name = "Retry download in Dark Mode with large text"
    screenshot.lifetime = .keepAlways
    add(screenshot)
    app.navigationBars.buttons.firstMatch.tap()
    XCTAssertEqual(app.staticTexts["cards-updated"].label, "Cards updated · 0 downloaded")
    app.staticTexts["A story ready for the journey"].firstMatch.tap()
    retry.tap()
    XCTAssertTrue(app.webViews.firstMatch.waitForExistence(timeout: 30))
    XCTAssertFalse(app.staticTexts["Fixture article unavailable"].exists)
  }
  func testBulkRetryFromDownloads() throws {
    try configureDownloads(failures: 1, status: 422)
    let app = launchReader()
    app.buttons["retry-download"].tap()
    XCTAssertTrue(app.buttons["Retry download"].waitForExistence(timeout: 20))
    app.tabBars.buttons["Downloads"].tap()
    app.buttons["Download details"].tap()
    let retry = app.buttons["retry-failed-downloads"]
    XCTAssertTrue(retry.isEnabled)
    retry.tap()
    let finished = XCTNSPredicateExpectation(
      predicate: NSPredicate(format: "exists == false OR enabled == false"), object: retry)
    XCTAssertEqual(XCTWaiter.wait(for: [finished], timeout: 30), .completed)
    app.tabBars.buttons["Home"].tap()
    XCTAssertTrue(app.webViews.firstMatch.waitForExistence(timeout: 30))
  }
  func testOfflineImagesUnicodeAndOriginalLink() throws {
    try configureDownloads(failures: 0, status: 503)
    let app = launchReader()
    app.buttons["retry-download"].tap()
    let quote = "A journalist’s café report — £20, José and “quoted words”."
    XCTAssertTrue(app.webViews.staticTexts[quote].waitForExistence(timeout: 30))
    let finished = XCTNSPredicateExpectation(
      predicate: NSPredicate(format: "exists == false"), object: app.staticTexts["Downloading…"])
    XCTAssertEqual(XCTWaiter.wait(for: [finished], timeout: 30), .completed)
    app.terminate()
    app.launchArguments = ["--ui-testing", "-server", "http://localhost:9", "-automatic", "NO"]
    app.launch()
    let headline = app.staticTexts["A story ready for the journey"]
    XCTAssertTrue(headline.waitForExistence(timeout: 20))
    headline.firstMatch.tap()
    XCTAssertTrue(app.webViews.staticTexts[quote].waitForExistence(timeout: 20))
    XCTAssertTrue(app.webViews.images["Offline test photograph"].exists)
    let original = app.webViews.links["Open original in browser"]
    if !original.isHittable { app.swipeUp() }
    XCTAssertTrue(original.isHittable)
    let screenshot = XCTAttachment(screenshot: app.screenshot())
    screenshot.name = "Offline image, UTF-8 text and original link"
    screenshot.lifetime = .keepAlways
    add(screenshot)
    original.tap()
    XCTAssertTrue(
      XCUIApplication(bundleIdentifier: "com.apple.mobilesafari").wait(
        for: .runningForeground, timeout: 15))
  }
  func testLongArticleTimelineAndStableScroll() throws {
    try configureDownloads(failures: 0, status: 503, long: true)
    let app = launchReader()
    app.buttons["retry-download"].tap()
    let jump = app.webViews.links.matching(
      NSPredicate(format: "label CONTAINS %@", "Jump to final update")
    ).firstMatch
    XCTAssertTrue(jump.waitForExistence(timeout: 45))
    let timeline = XCTAttachment(screenshot: app.screenshot())
    timeline.name = "Compact offline timeline on 2000-block article"
    timeline.lifetime = .keepAlways
    add(timeline)
    jump.tap()
    let end = app.webViews.otherElements["Final update reached"]
    XCTAssertTrue(end.waitForExistence(timeout: 20))
    XCTAssertTrue(end.isHittable)
    let wasSaved = app.buttons["Unsave"].exists
    app.buttons[wasSaved ? "Unsave" : "Save"].tap()
    let toggled = app.buttons[wasSaved ? "Save" : "Unsave"]
    XCTAssertTrue(toggled.waitForExistence(timeout: 10))
    XCTAssertTrue(end.isHittable, "Library changes must not reload or reset the reader")
    for _ in 0..<6 { app.webViews.firstMatch.swipeDown(velocity: .fast) }
    XCTAssertTrue(toggled.isHittable)
    XCTAssertTrue(app.webViews.firstMatch.exists)
  }
  func testStoriesRecoverWithoutPullingToRefresh() {
    let app = XCUIApplication()
    let server = ProcessInfo.processInfo.environment["TAB1_FIXTURE_SERVER"] ?? "http://localhost:3068"
    app.launchArguments = ["--ui-testing", "--reset-ui-library", "-server",
                           server + "/retry-once/" + UUID().uuidString, "-automatic", "NO"]
    app.launch()
    XCTAssertTrue(app.staticTexts["Couldn’t update stories. Retrying automatically…"].waitForExistence(timeout: 6))
    XCTAssertTrue(app.staticTexts["A story ready for the journey"].firstMatch.waitForExistence(timeout: 20))
  }
  func testSlowPullRefreshContinuesAcrossTabs() {
    let app = XCUIApplication()
    let server = ProcessInfo.processInfo.environment["TAB1_FIXTURE_SERVER"] ?? "http://localhost:3068"
    app.launchArguments = ["--ui-testing", "--reset-ui-library", "-server", server + "/slow-refresh", "-automatic", "NO"]
    app.launch()
    let updated = app.staticTexts["cards-updated"]
    XCTAssertTrue(updated.waitForExistence(timeout: 25))
    XCTAssertEqual(updated.label, "Cards updated · 0 downloaded")
    let scroll = app.scrollViews.firstMatch
    let start = scroll.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.15))
    let end = scroll.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.85))
    start.press(forDuration: 0.05, thenDragTo: end, withVelocity: .fast, thenHoldForDuration: 0.2)
    XCTAssertTrue(app.staticTexts["Updating stories…"].waitForExistence(timeout: 4))
    app.tabBars.buttons["Downloads"].tap()
    XCTAssertTrue(updated.waitForExistence(timeout: 15))
    app.tabBars.buttons["Home"].tap()
    XCTAssertTrue(updated.exists)
    XCTAssertFalse(app.staticTexts["cancelled"].exists)
  }
  func testHomeWithoutCacheWhenServerIsUnavailable() {
    let app = XCUIApplication()
    app.launchArguments = [
      "--ui-testing", "--reset-ui-library", "-server", "http://localhost:9", "-automatic", "NO",
      "-AppleInterfaceStyle", "Dark", "-UIPreferredContentSizeCategoryName",
      "UICTContentSizeCategoryXXXL",
    ]
    app.launch()
    let emptyState = app.staticTexts["Your day, in one place"]
    XCTAssertTrue(emptyState.waitForExistence(timeout: 15))
    XCTAssertTrue(emptyState.isHittable)
    XCTAssertTrue(app.buttons["home-search-button"].isHittable)
  }
  func testForecastDaySelection() {
    let app = XCUIApplication()
    let server = ProcessInfo.processInfo.environment["TAB1_FIXTURE_SERVER"] ?? "http://localhost:3068"
    app.launchArguments = ["--ui-testing", "--reset-ui-library", "-server", server, "-automatic", "NO"]
    app.launch()
    XCTAssertTrue(app.staticTexts["A story ready for the journey"].firstMatch.waitForExistence(timeout: 30))
    app.buttons["Weather"].tap()
    XCTAssertTrue(app.staticTexts["Beckenham"].waitForExistence(timeout: 10))
    let options = app.buttons["Forecast options"]
    XCTAssertLessThanOrEqual(options.frame.maxY, app.staticTexts["Beckenham"].frame.minY)
    let yesterday = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Yesterday,'")).firstMatch
    let today = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Today,'")).firstMatch
    XCTAssertTrue(yesterday.exists)
    XCTAssertLessThan(yesterday.frame.maxX, today.frame.minX)
    XCTAssertTrue(today.isSelected)
    let screenshot = XCTAttachment(screenshot: app.screenshot())
    screenshot.name = "Today’s forecast"
    screenshot.lifetime = .keepAlways
    add(screenshot)
    let tomorrow = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Tomorrow,'")).firstMatch
    yesterday.tap()
    XCTAssertTrue(yesterday.isSelected)
    tomorrow.tap()
    XCTAssertTrue(tomorrow.isSelected)
    XCTAssertTrue(app.staticTexts["Hour by hour"].exists)
    app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Today,'")).firstMatch.tap()
    XCTAssertTrue(app.staticTexts["Today’s outlook"].exists)
  }

  func testHomeSearchOpensAndCancels() throws {
    let app = XCUIApplication()
    app.launchArguments = [
      "--ui-testing", "--reset-ui-library", "-server", "http://localhost:3068", "-automatic", "NO",
    ]
    app.launch()
    let headline = app.staticTexts["A story ready for the journey"]
    XCTAssertTrue(headline.waitForExistence(timeout: 45))
    let field = app.textFields["home-search-field"]
    XCTAssertFalse(field.exists)
    let searchButton = app.buttons["home-search-button"]
    XCTAssertTrue(searchButton.isHittable)
    XCTAssertTrue(app.buttons["Weather"].isHittable)
    searchButton.tap()
    XCTAssertTrue(field.waitForExistence(timeout: 5))
    XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
    field.typeText("Journey story 9")
    XCTAssertTrue(app.staticTexts["Journey story 9"].exists)
    XCTAssertFalse(headline.exists)
    app.buttons["Cancel"].tap()
    XCTAssertFalse(field.exists)
    XCTAssertTrue(headline.exists)
    XCTAssertTrue(searchButton.isHittable)
  }
  func testAppOnlyTopicsPersist() throws {
    let app = XCUIApplication()
    app.launchArguments = [
      "--ui-testing", "--reset-ui-library", "-server", "http://localhost:3068", "-automatic", "NO",
    ]
    app.launch()
    XCTAssertTrue(app.staticTexts["A story ready for the journey"].waitForExistence(timeout: 45))
    app.tabBars.buttons["Settings"].tap()
    app.buttons["App-only topics"].tap()
    let toggle = app.switches["app-topic-science"]
    XCTAssertTrue(toggle.waitForExistence(timeout: 10))
    toggle.coordinate(withNormalizedOffset: CGVector(dx: 0.93, dy: 0.5)).tap()
    XCTAssertEqual(toggle.value as? String, "1")
    app.navigationBars.buttons.firstMatch.tap()
    app.tabBars.buttons["Home"].tap()
    XCTAssertTrue(app.staticTexts["App-only science story"].waitForExistence(timeout: 15))
    app.terminate()
    app.launchArguments = ["--ui-testing", "-server", "http://localhost:3068", "-automatic", "NO"]
    app.launch()
    app.tabBars.buttons["Settings"].tap()
    app.buttons["App-only topics"].tap()
    XCTAssertTrue(toggle.waitForExistence(timeout: 10))
    XCTAssertEqual(toggle.value as? String, "1")
  }
  func testCardsExpandAndCollapse() throws {
    let app = XCUIApplication()
    app.launchArguments = [
      "--ui-testing", "--reset-ui-library", "-server", "http://localhost:3068", "-automatic", "NO",
    ]
    app.launch()
    let toggle = app.buttons["expand-fixture"]
    XCTAssertTrue(toggle.waitForExistence(timeout: 45))
    XCTAssertTrue(app.staticTexts["A story ready for the journey"].exists)
    app.swipeUp()
    XCTAssertEqual(toggle.value as? String, "Collapsed")
    toggle.tap()
    XCTAssertEqual(toggle.value as? String, "Expanded")
    app.swipeUp()
    XCTAssertTrue(app.staticTexts["Journey story 9"].exists)
    toggle.tap()
    XCTAssertEqual(toggle.value as? String, "Collapsed")
    XCTAssertFalse(app.staticTexts["Journey story 9"].exists)
  }
  func testCommentsLinkRefreshAndOfflineRelaunch() {
    let app = XCUIApplication()
    let server = ProcessInfo.processInfo.environment["TAB1_FIXTURE_SERVER"] ?? "http://localhost:3068"
    app.launchArguments = ["--ui-testing", "--reset-ui-library", "-server", server, "-automatic", "NO",
                           "-AppleInterfaceStyle", "Dark", "-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryXXXL"]
    app.launch()
    let comments = app.buttons["1 comment"].firstMatch
    XCTAssertTrue(comments.waitForExistence(timeout: 30))
    XCTAssertTrue(app.descendants(matching: .any)["story-age-3h"].firstMatch.exists)
    comments.tap()
    XCTAssertTrue(app.staticTexts["A thoughtful offline reply."].waitForExistence(timeout: 30))
    app.buttons["Refresh comments"].tap()
    let updated = app.staticTexts["A freshly updated reply."]
    XCTAssertTrue(updated.waitForExistence(timeout: 30))
    app.terminate()
    app.launchArguments = ["--ui-testing", "-server", "http://localhost:9", "-automatic", "NO"]
    app.launch()
    XCTAssertTrue(comments.waitForExistence(timeout: 15))
    comments.tap()
    XCTAssertTrue(updated.waitForExistence(timeout: 15))
    XCTAssertTrue(app.staticTexts["2 comments saved"].exists)
    let guide = app.descendants(matching: .any).matching(
      NSPredicate(format: "label == %@", "Discussion guide")
    ).firstMatch
    XCTAssertTrue(guide.isHittable)
    guide.tap()
    XCTAssertTrue(XCUIApplication(bundleIdentifier: "com.apple.mobilesafari")
      .wait(for: .runningForeground, timeout: 15))
  }
  func testInteractionsDuringAutomaticDownloads() throws {
    try configureDownloads(failures: 0, status: 503)
    let app = XCUIApplication()
    app.launchArguments = ["--ui-testing", "--reset-ui-library", "-server",
                           "http://localhost:3068/busy-library", "-automatic", "YES"]
    app.launch()
    let progress = app.descendants(matching: .any)["download-progress"].firstMatch
    XCTAssertTrue(progress.waitForExistence(timeout: 20))
    let options = XCTMeasureOptions()
    options.iterationCount = 1
    measure(metrics: [XCTOSSignpostMetric.scrollingAndDecelerationMetric, XCTClockMetric()], options: options) {
      XCTAssertTrue(progress.exists, "The interaction must start with downloads active")
      app.scrollViews.firstMatch.swipeUp()
      app.scrollViews.firstMatch.swipeDown()
    }
    app.buttons["home-search-button"].tap()
    let field = app.textFields["home-search-field"]
    XCTAssertTrue(field.waitForExistence(timeout: 3))
    field.typeText("Section 4 story 2")
    XCTAssertTrue(app.staticTexts["Section 4 story 2"].exists)
    app.buttons["Cancel"].tap()
    app.tabBars.buttons["Downloads"].tap()
    let finished = XCTNSPredicateExpectation(
      predicate: NSPredicate(format: "label == %@", "Downloads complete"), object: progress)
    XCTAssertEqual(XCTWaiter.wait(for: [finished], timeout: 150), .completed)
  }

  func testDownloadThenColdLaunchOffline() throws {
    let app = XCUIApplication()
    app.launchArguments = [
      "--ui-testing", "--reset-ui-library", "-server", "http://localhost:3068", "-automatic", "YES",
    ]
    app.launch()
    let headline = app.staticTexts["A story ready for the journey"]
    XCTAssertTrue(headline.waitForExistence(timeout: 45))
    app.tabBars.buttons["Downloads"].tap()
    let ready = app.staticTexts["Ready offline"].firstMatch
    XCTAssertTrue(ready.waitForExistence(timeout: 60))
    app.tabBars.buttons["Home"].tap()
    headline.firstMatch.tap()
    XCTAssertTrue(app.webViews.firstMatch.waitForExistence(timeout: 15))
    XCTAssertTrue(
      app.webViews.staticTexts["Offline reading works even when the connection disappears."]
        .waitForExistence(timeout: 15))
    if app.buttons["Unsave"].exists { app.buttons["Unsave"].tap() }
    app.buttons["Save"].tap()
    app.terminate()
    app.launchArguments = ["--ui-testing", "-server", "http://localhost:9", "-automatic", "NO"]
    app.launch()
    XCTAssertTrue(headline.waitForExistence(timeout: 15))
    headline.firstMatch.tap()
    XCTAssertTrue(
      app.webViews.staticTexts["Offline reading works even when the connection disappears."]
        .waitForExistence(timeout: 15))
    app.buttons["Comments"].tap()
    XCTAssertTrue(app.staticTexts["A thoughtful offline reply."].waitForExistence(timeout: 15))
  }

  @MainActor func testNewEditionDownloadsWhileBackgrounded() async throws {
    try await checkBackgroundEdition(refreshInProgress: false)
  }

  @MainActor func testInProgressRefreshDownloadsWhileBackgrounded() async throws {
    try await checkBackgroundEdition(refreshInProgress: true)
  }

  @MainActor func testBackgroundEditionRetriesBadGateway() async throws {
    try await checkBackgroundEdition(refreshInProgress: false, failFirstArticle: true)
  }

  @MainActor func testCachedEditionDownloadsInBackgroundWhenSyncFails() async throws {
    try await checkBackgroundEdition(refreshInProgress: false, cachedBeforeExit: true)
  }

  @MainActor private func checkBackgroundEdition(
    refreshInProgress: Bool, failFirstArticle: Bool = false, cachedBeforeExit: Bool = false
  ) async throws {
    let fixtureServer = ProcessInfo.processInfo.environment["TAB1_FIXTURE_SERVER"] ?? "http://localhost:3068"
    let server = fixtureServer + "/background-edition/" + UUID().uuidString
    func fixture(_ action: String? = nil) async throws -> Bool {
      var request = URLRequest(url: URL(string: server + "/test")!)
      if let action {
        request.httpMethod = "POST"
        request.httpBody = try JSONEncoder().encode([action: true])
      }
      let (data, response) = try await URLSession.shared.data(for: request)
      XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
      return try JSONDecoder().decode([String: Bool].self, from: data)["served"] == true
    }

    let app = XCUIApplication()
    if refreshInProgress { _ = try await fixture("holdFirst") }
    if failFirstArticle { _ = try await fixture("failFirstArticle") }
    if cachedBeforeExit { _ = try await fixture("publish") }
    app.launchArguments = ["--ui-testing", "--reset-ui-library", "-server", server, "-automatic", cachedBeforeExit ? "NO" : "YES"]
    app.launch()
    let status = refreshInProgress ? "Updating stories…" : "cards-updated"
    XCTAssertTrue(app.staticTexts[status].waitForExistence(timeout: 30))
    if cachedBeforeExit {
      XCTAssertTrue(app.staticTexts["Afternoon edition"].exists)
      app.terminate()
      _ = try await fixture("failSync")
      app.launchArguments = ["--ui-testing", "-server", server, "-automatic", "YES"]
      app.launch()
      XCTAssertTrue(app.staticTexts["Couldn’t update stories. Retrying automatically…"].waitForExistence(timeout: 15))
      let servedBeforeExit = try await fixture()
      XCTAssertFalse(servedBeforeExit)
    } else {
      XCTAssertFalse(app.staticTexts["Afternoon edition"].exists)
    }
    XCUIDevice.shared.press(.home)
    XCTAssertTrue(app.wait(for: .runningBackground, timeout: 8) || app.state == .runningBackgroundSuspended)
    _ = try await fixture("publish")
    let deadline = ContinuousClock.now.advanced(by: .seconds(40))
    var served = try await fixture()
    while !served && ContinuousClock.now < deadline {
      try await Task.sleep(for: .milliseconds(250))
      served = try await fixture()
    }
    XCTAssertTrue(served, "The new article must be fetched before foregrounding")
    _ = try await fixture("disconnect")
    app.activate()
    let headline = app.staticTexts["Afternoon edition"].firstMatch
    XCTAssertTrue(headline.waitForExistence(timeout: 10))
    headline.tap()
    let body = app.webViews.staticTexts["The afternoon report is ready to read offline."]
    XCTAssertTrue(body.waitForExistence(timeout: 15))

    app.terminate()
    app.launchArguments = ["--ui-testing", "-server", "http://localhost:9", "-automatic", "NO"]
    app.launch()
    XCTAssertTrue(headline.waitForExistence(timeout: 10))
    headline.tap()
    XCTAssertTrue(body.waitForExistence(timeout: 10))
  }
}
