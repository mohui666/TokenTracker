import XCTest

final class MenuBarIconStyleTests: XCTestCase {
    private var defaults: UserDefaults!
    private let suiteName = "MenuBarIconStyleTests"

    override func setUp() {
        super.setUp()
        defaults = UserDefaults(suiteName: suiteName)
        defaults.removePersistentDomain(forName: suiteName)
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suiteName)
        defaults = nil
        super.tearDown()
    }

    // MARK: - Defaults & persistence

    func testDefaultsToClawdWhenNothingStored() {
        XCTAssertEqual(MenuBarIconStyle.current(defaults: defaults), .clawd)
    }

    func testRoundTripsEveryStyle() {
        for style in MenuBarIconStyle.allCases {
            MenuBarIconStyle.setCurrent(style, defaults: defaults)
            XCTAssertEqual(MenuBarIconStyle.current(defaults: defaults), style)
        }
    }

    func testInvalidStoredValueFallsBackToClawd() {
        defaults.set("dog", forKey: MenuBarIconStyle.defaultsKey)
        XCTAssertEqual(MenuBarIconStyle.current(defaults: defaults), .clawd)
    }

    // MARK: - Legacy "Animated icon" toggle migration

    func testLegacyAnimationDisabledMigratesToStatic() {
        defaults.set(false, forKey: MenuBarIconStyle.legacyAnimationEnabledKey)
        XCTAssertEqual(MenuBarIconStyle.current(defaults: defaults), .static)
    }

    func testLegacyAnimationEnabledMigratesToClawd() {
        defaults.set(true, forKey: MenuBarIconStyle.legacyAnimationEnabledKey)
        XCTAssertEqual(MenuBarIconStyle.current(defaults: defaults), .clawd)
    }

    func testExplicitStyleWinsOverLegacyToggle() {
        defaults.set(false, forKey: MenuBarIconStyle.legacyAnimationEnabledKey)
        MenuBarIconStyle.setCurrent(.cat, defaults: defaults)
        XCTAssertEqual(MenuBarIconStyle.current(defaults: defaults), .cat)
    }

    // MARK: - Runner pace contract

    func testCatSpeedTiers() {
        XCTAssertEqual(MenuBarRunnerPace.frameInterval(style: .cat, motion: .sleeping), 1.2)
        XCTAssertEqual(MenuBarRunnerPace.frameInterval(style: .cat, motion: .idle), 0.5)
        XCTAssertEqual(MenuBarRunnerPace.frameInterval(style: .cat, motion: .syncing), 0.2)
        XCTAssertEqual(MenuBarRunnerPace.frameInterval(style: .cat, motion: .sprinting), 0.08)
    }

    func testPetSpeedTiers() {
        XCTAssertEqual(MenuBarRunnerPace.frameInterval(style: .pet, motion: .sleeping), 0.6)
        XCTAssertEqual(MenuBarRunnerPace.frameInterval(style: .pet, motion: .idle), 0.4)
        XCTAssertEqual(MenuBarRunnerPace.frameInterval(style: .pet, motion: .syncing), 0.15)
        XCTAssertEqual(MenuBarRunnerPace.frameInterval(style: .pet, motion: .sprinting), 0.08)
    }

    func testBotSpeedTiers() {
        // bot expresses state through WHICH clip plays, so sprinting matches syncing
        // rather than going faster; the clips are sampled at 24 fps and idle plays them
        // at half rate to keep the always-on recomposition cost down.
        XCTAssertEqual(MenuBarRunnerPace.frameInterval(style: .bot, motion: .sleeping), 1.0 / 8.0)
        XCTAssertEqual(MenuBarRunnerPace.frameInterval(style: .bot, motion: .idle), 1.0 / 12.0)
        XCTAssertEqual(MenuBarRunnerPace.frameInterval(style: .bot, motion: .syncing), 1.0 / 24.0)
        XCTAssertEqual(MenuBarRunnerPace.frameInterval(style: .bot, motion: .sprinting), 1.0 / 24.0)
    }

    /// Sprinting is never SLOWER than a calmer tier, for every style — iterated over
    /// `allCases` rather than a hand-kept list so a new style cannot skip the check.
    /// `bot` ties instead of strictly winning, which is why this is `<=`; the strict
    /// ordering for the runner styles is pinned by their own tier tests above.
    func testSprintingIsNeverSlowerThanACalmerTier() {
        for style in MenuBarIconStyle.allCases {
            let sprint = MenuBarRunnerPace.frameInterval(style: style, motion: .sprinting)
            for motion in [MenuBarRunnerMotion.sleeping, .idle, .syncing] {
                XCTAssertLessThanOrEqual(
                    sprint,
                    MenuBarRunnerPace.frameInterval(style: style, motion: motion),
                    "\(style.rawValue) sprints slower than \(motion)"
                )
            }
        }
    }

    func testSprintWindowIsHalfAMinute() {
        XCTAssertEqual(MenuBarRunnerPace.sprintWindow, 30)
    }
}
