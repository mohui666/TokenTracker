import Foundation

/// Pure preference and value-selection policy for the Dynamic Island's
/// compact collapsed layout. Keeping this independent of SwiftUI makes its
/// fallback behaviour deterministic and directly testable.
enum DynamicIslandCompactPolicy {
    static let enabledDefaultsKey = "DynamicIslandCompactModeEnabled"

    static func isEnabled(from defaults: UserDefaults = .standard) -> Bool {
        defaults.bool(forKey: enabledDefaultsKey)
    }

    static func write(_ enabled: Bool, to defaults: UserDefaults = .standard) {
        defaults.set(enabled, forKey: enabledDefaultsKey)
    }

    /// The first currently healthy, visible limit metric. `keepingSelected` is
    /// deliberately empty: a stale selected slot must not become an auto-ring
    /// candidate while its provider is unavailable.
    ///
    /// `excluding` keeps the auto-picked ring from landing on a metric the
    /// opposite wing already renders — otherwise both wings show the same
    /// window and the ring carries no information the user cannot already read.
    static func resolveAutoRingMetric(
        limits: UsageLimitsResponse?,
        hiddenProviders: Set<String>,
        excluding: MenuBarDisplayMetric? = nil
    ) -> MenuBarDisplayMetric? {
        MenuBarDisplayPreferences.availableItemIDs(
            for: limits,
            keepingSelected: [],
            hiddenProviders: hiddenProviders
        )
        .compactMap(MenuBarDisplayMetric.init(rawValue:))
        .first { $0.settingsCategory == "limits" && $0 != excluding }
    }

    /// Uses a viable Primary slot directly. A non-limit or unavailable Primary
    /// falls back to auto, while nil preserves the user's explicit empty slot.
    ///
    /// Only the fallback path can collide with the opposite wing: slot
    /// normalization already rejects the same metric in both slots, so an
    /// explicitly chosen Primary is always distinct from `secondarySlot` and is
    /// honored as-is. When the fallback has no distinct candidate left, the ring
    /// stays empty rather than mirroring the other wing.
    static func resolveRingMetric(
        primarySlot: MenuBarDisplayMetric?,
        secondarySlot: MenuBarDisplayMetric? = nil,
        limits: UsageLimitsResponse?,
        hiddenProviders: Set<String>
    ) -> MenuBarDisplayMetric? {
        guard let primarySlot else { return nil }
        let available = MenuBarDisplayPreferences.availableItemIDs(
            for: limits,
            keepingSelected: [],
            hiddenProviders: hiddenProviders
        )
        guard primarySlot.settingsCategory == "limits",
              available.contains(primarySlot.rawValue) else {
            return resolveAutoRingMetric(
                limits: limits,
                hiddenProviders: hiddenProviders,
                excluding: secondarySlot
            )
        }
        return primarySlot
    }

    /// `trim` follows the selected display mode; `color` always tracks raw
    /// utilization so a short remaining ring can still communicate urgency.
    static func ringValues(
        pct: Double?,
        displayMode: LimitDisplayMode
    ) -> (trim: Double, color: Double)? {
        guard let pct else { return nil }
        let used = min(max(pct, 0), 100) / 100
        return (displayMode == .remaining ? 1 - used : used, used)
    }

    static func quotaColor(colorValue: Double) -> RingColorTier {
        switch colorValue {
        case ..<0.5: return .green
        case ..<0.8: return .yellow
        default: return .red
        }
    }
}

enum RingColorTier: Equatable {
    case green
    case yellow
    case red
}
