import XCTest

final class DynamicIslandCompactPolicyTests: XCTestCase {
    func testCompactModeDefaultsOffAndRoundTrips() throws {
        let suiteName = "DynamicIslandCompactPolicyTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }

        XCTAssertFalse(DynamicIslandCompactPolicy.isEnabled(from: defaults))
        DynamicIslandCompactPolicy.write(true, to: defaults)
        XCTAssertTrue(DynamicIslandCompactPolicy.isEnabled(from: defaults))
        DynamicIslandCompactPolicy.write(false, to: defaults)
        XCTAssertFalse(DynamicIslandCompactPolicy.isEnabled(from: defaults))
    }

    func testResolveRingMetricUsesPrimaryLimitWhenCurrent() throws {
        let limits = try response(claude: ["configured": true, "five_hour": ["utilization": 30.0]])

        XCTAssertEqual(
            DynamicIslandCompactPolicy.resolveRingMetric(
                primarySlot: .claude5h,
                limits: limits,
                hiddenProviders: []
            ),
            .claude5h
        )
    }

    func testResolveRingMetricFallsBackForNonLimitOrUnavailablePrimary() throws {
        let limits = try response(overrides: [
            "claude": ["configured": true, "five_hour": ["utilization": 30.0]],
            "codex": ["configured": true, "primary_window": ["used_percent": 40]],
        ])

        XCTAssertEqual(
            DynamicIslandCompactPolicy.resolveRingMetric(
                primarySlot: .todayTokens,
                limits: limits,
                hiddenProviders: []
            ),
            .claude5h
        )
        XCTAssertEqual(
            DynamicIslandCompactPolicy.resolveRingMetric(
                primarySlot: .claude5h,
                limits: limits,
                hiddenProviders: ["claude"]
            ),
            .codex5h
        )
    }

    func testResolveRingMetricFallsBackForUnconfiguredPrimaryProvider() throws {
        let limits = try response(overrides: [
            "claude": ["configured": false, "five_hour": ["utilization": 30.0]],
            "codex": ["configured": true, "primary_window": ["used_percent": 40]],
        ])

        XCTAssertEqual(
            DynamicIslandCompactPolicy.resolveRingMetric(
                primarySlot: .claude5h,
                limits: limits,
                hiddenProviders: []
            ),
            .codex5h
        )
    }

    func testResolveRingMetricFallsBackWhenPrimaryWindowIsMissing() throws {
        let limits = try response(claude: ["configured": true, "five_hour": ["utilization": 30.0]])

        XCTAssertEqual(
            DynamicIslandCompactPolicy.resolveRingMetric(
                primarySlot: .claude7d,
                limits: limits,
                hiddenProviders: []
            ),
            .claude5h
        )
    }

    func testResolveRingMetricFallbackSkipsTheMetricOnTheOppositeWing() throws {
        let limits = try response(overrides: [
            "claude": ["configured": true, "five_hour": ["utilization": 79.0]],
            "codex": ["configured": true, "primary_window": ["used_percent": 40]],
        ])

        // Without the exclusion the ring would mirror the right wing exactly.
        XCTAssertEqual(
            DynamicIslandCompactPolicy.resolveRingMetric(
                primarySlot: .todayCost,
                secondarySlot: .claude5h,
                limits: limits,
                hiddenProviders: []
            ),
            .codex5h
        )
    }

    func testResolveRingMetricFallbackStaysEmptyWhenOnlyCandidateIsOnTheOtherWing() throws {
        let limits = try response(claude: ["configured": true, "five_hour": ["utilization": 79.0]])

        XCTAssertNil(DynamicIslandCompactPolicy.resolveRingMetric(
            primarySlot: .todayCost,
            secondarySlot: .claude5h,
            limits: limits,
            hiddenProviders: []
        ))
    }

    func testResolveRingMetricKeepsAnExplicitPrimaryEvenIfItMatchesSecondary() throws {
        let limits = try response(claude: ["configured": true, "five_hour": ["utilization": 79.0]])

        // Slot normalization rejects duplicate slots, so an explicit Primary is
        // honored rather than second-guessed.
        XCTAssertEqual(
            DynamicIslandCompactPolicy.resolveRingMetric(
                primarySlot: .claude5h,
                secondarySlot: .claude5h,
                limits: limits,
                hiddenProviders: []
            ),
            .claude5h
        )
    }

    func testAutoRingMetricExclusionFallsThroughToTheNextWindowOfSameProvider() throws {
        let limits = try response(claude: [
            "configured": true,
            "five_hour": ["utilization": 79.0],
            "seven_day": ["utilization": 42.0],
        ])

        XCTAssertEqual(
            DynamicIslandCompactPolicy.resolveAutoRingMetric(
                limits: limits,
                hiddenProviders: [],
                excluding: .claude5h
            ),
            .claude7d
        )
    }

    func testResolveRingMetricHonorsExplicitNone() throws {
        let limits = try response(claude: ["configured": true, "five_hour": ["utilization": 30.0]])

        XCTAssertNil(DynamicIslandCompactPolicy.resolveRingMetric(
            primarySlot: nil,
            limits: limits,
            hiddenProviders: []
        ))
    }

    func testAutoRingMetricRequiresHealthyVisibleWindow() throws {
        XCTAssertNil(DynamicIslandCompactPolicy.resolveAutoRingMetric(limits: nil, hiddenProviders: []))
        XCTAssertNil(DynamicIslandCompactPolicy.resolveAutoRingMetric(
            limits: try response(),
            hiddenProviders: []
        ))

        let healthy = try response(claude: ["configured": true, "five_hour": ["utilization": 30.0]])
        XCTAssertEqual(
            DynamicIslandCompactPolicy.resolveAutoRingMetric(limits: healthy, hiddenProviders: []),
            .claude5h
        )
        XCTAssertNil(DynamicIslandCompactPolicy.resolveAutoRingMetric(
            limits: healthy,
            hiddenProviders: ["claude"]
        ))

        let windowless = try response(claude: ["configured": true])
        XCTAssertNil(DynamicIslandCompactPolicy.resolveAutoRingMetric(limits: windowless, hiddenProviders: []))

        let errored = try response(overrides: [
            "claude": ["configured": true, "error": "429", "five_hour": ["utilization": 30.0]],
            "codex": ["configured": true, "primary_window": ["used_percent": 40]],
        ])
        XCTAssertEqual(
            DynamicIslandCompactPolicy.resolveAutoRingMetric(limits: errored, hiddenProviders: []),
            .codex5h
        )
    }

    func testRingValuesSeparateDisplayTrimFromRawUsageColor() {
        XCTAssertNil(DynamicIslandCompactPolicy.ringValues(pct: nil, displayMode: .used))
        XCTAssertEqualValues(DynamicIslandCompactPolicy.ringValues(pct: 30, displayMode: .used), trim: 0.30, color: 0.30)
        XCTAssertEqualValues(DynamicIslandCompactPolicy.ringValues(pct: 30, displayMode: .remaining), trim: 0.70, color: 0.30)
        XCTAssertEqualValues(DynamicIslandCompactPolicy.ringValues(pct: 85, displayMode: .remaining), trim: 0.15, color: 0.85)
        XCTAssertEqualValues(DynamicIslandCompactPolicy.ringValues(pct: 0, displayMode: .used), trim: 0, color: 0)
        XCTAssertEqualValues(DynamicIslandCompactPolicy.ringValues(pct: 100, displayMode: .used), trim: 1, color: 1)
        XCTAssertEqualValues(DynamicIslandCompactPolicy.ringValues(pct: 120, displayMode: .used), trim: 1, color: 1)
        XCTAssertEqualValues(DynamicIslandCompactPolicy.ringValues(pct: 0, displayMode: .remaining), trim: 1, color: 0)
        XCTAssertEqualValues(DynamicIslandCompactPolicy.ringValues(pct: 100, displayMode: .remaining), trim: 0, color: 1)
        XCTAssertEqualValues(DynamicIslandCompactPolicy.ringValues(pct: 120, displayMode: .remaining), trim: 0, color: 1)
    }

    func testQuotaColorBoundaries() {
        XCTAssertEqual(DynamicIslandCompactPolicy.quotaColor(colorValue: 0.499), .green)
        XCTAssertEqual(DynamicIslandCompactPolicy.quotaColor(colorValue: 0.5), .yellow)
        XCTAssertEqual(DynamicIslandCompactPolicy.quotaColor(colorValue: 0.799), .yellow)
        XCTAssertEqual(DynamicIslandCompactPolicy.quotaColor(colorValue: 0.8), .red)
    }

    private func XCTAssertEqualValues(
        _ actual: (trim: Double, color: Double)?,
        trim: Double,
        color: Double,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        guard let actual else {
            XCTFail("Expected ring values", file: file, line: line)
            return
        }
        XCTAssertEqual(actual.trim, trim, accuracy: 0.000_001, file: file, line: line)
        XCTAssertEqual(actual.color, color, accuracy: 0.000_001, file: file, line: line)
    }

    private func response(
        claude: [String: Any] = ["configured": false],
        overrides: [String: Any] = [:]
    ) throws -> UsageLimitsResponse {
        var payload: [String: Any] = [
            "fetched_at": "2026-08-17T00:00:00Z",
            "claude": claude,
            "codex": ["configured": false],
            "cursor": ["configured": false],
            "gemini": ["configured": false],
            "kiro": ["configured": false],
            "antigravity": ["configured": false],
        ]
        for (key, value) in overrides {
            payload[key] = value
        }
        return try JSONDecoder().decode(
            UsageLimitsResponse.self,
            from: JSONSerialization.data(withJSONObject: payload)
        )
    }
}
