import XCTest

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
  private func launchReader(extraArguments: [String] = []) -> XCUIApplication {
    let app = XCUIApplication()
    app.launchArguments = [
      "--ui-testing", "--reset-ui-library", "-server", "http://localhost:3068", "-automatic", "NO",
    ]
    app.launchArguments += extraArguments
    app.launch()
    let headline = app.staticTexts["A story ready for the journey"]
    XCTAssertTrue(headline.waitForExistence(timeout: 45))
    headline.firstMatch.tap()
    return app
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
    XCTAssertTrue(progress.waitForExistence(timeout: 10))
    XCTAssertTrue(progress.isHittable)
    app.tabBars.buttons["Downloads"].tap()
    XCTAssertTrue(progress.isHittable)
    let complete = XCTNSPredicateExpectation(
      predicate: NSPredicate(format: "label == %@ AND value == %@", "Downloads complete", "3 of 3 downloaded"),
      object: progress)
    XCTAssertEqual(XCTWaiter.wait(for: [complete], timeout: 120), .completed)
    app.tabBars.buttons["Home"].tap()
    XCTAssertFalse(progress.exists)
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
    let updated = app.staticTexts["Cards updated"]
    XCTAssertTrue(updated.waitForExistence(timeout: 25))
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
}
