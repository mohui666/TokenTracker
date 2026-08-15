import Foundation

/// Persistence for the auto-update toggle (GitHub discussion #424).
///
/// Foundation-only so the standalone TokenTrackerBarTests bundle can compile and
/// verify the default-on contract without pulling in the AppKit-coupled
/// `UpdateChecker`. The checker reads this before every silent launch check;
/// manual "Check for Updates" is never gated by it.
enum AutoUpdatePolicy {
    /// UserDefaults key backing the toggle. Missing value means enabled, so the
    /// historical behavior (silent auto-update on launch) is unchanged until the
    /// user explicitly turns it off.
    static let enabledKey = "UpdateChecker.autoUpdateEnabled"

    static func isEnabled(_ defaults: UserDefaults = .standard) -> Bool {
        defaults.object(forKey: enabledKey) as? Bool ?? true
    }
}
