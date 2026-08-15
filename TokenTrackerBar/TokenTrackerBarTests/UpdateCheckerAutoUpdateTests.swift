import XCTest

final class UpdateCheckerAutoUpdateTests: XCTestCase {

    private func makeIsolatedDefaults() -> (UserDefaults, String) {
        let suiteName = "UpdateCheckerAutoUpdateTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName)!
        return (defaults, suiteName)
    }

    func testAutoUpdateDefaultsToEnabledWhenUnset() {
        let (defaults, suiteName) = makeIsolatedDefaults()
        defer { defaults.removePersistentDomain(forName: suiteName) }

        XCTAssertTrue(
            AutoUpdatePolicy.isEnabled(defaults),
            "auto-update must default to enabled so existing behavior is unchanged (discussion #424)"
        )
    }

    func testAutoUpdateReadsPersistedToggle() {
        let (defaults, suiteName) = makeIsolatedDefaults()
        defer { defaults.removePersistentDomain(forName: suiteName) }

        defaults.set(false, forKey: AutoUpdatePolicy.enabledKey)
        XCTAssertFalse(AutoUpdatePolicy.isEnabled(defaults))

        defaults.set(true, forKey: AutoUpdatePolicy.enabledKey)
        XCTAssertTrue(AutoUpdatePolicy.isEnabled(defaults))
    }

    func testAutoUpdateRoundTripsThroughStandardDefaults() {
        let original = AutoUpdatePolicy.isEnabled()
        defer { UserDefaults.standard.set(original, forKey: AutoUpdatePolicy.enabledKey) }

        UserDefaults.standard.set(false, forKey: AutoUpdatePolicy.enabledKey)
        XCTAssertFalse(AutoUpdatePolicy.isEnabled())

        UserDefaults.standard.set(true, forKey: AutoUpdatePolicy.enabledKey)
        XCTAssertTrue(AutoUpdatePolicy.isEnabled())
    }
}
