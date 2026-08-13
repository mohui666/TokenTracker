export const STATUSPAGE_URL = "https://tokentracker.statuspage.io/";

export const REPO_URL = "https://github.com/mohui666/TokenTracker";
export const PRIVACY_URL = `${REPO_URL}/blob/main/docs/PRIVACY.md`;
// The releases page lists every asset (used for the "other platforms" link and
// as the fallback when we can't detect the OS).
export const RELEASES_URL = `${REPO_URL}/releases/latest`;
// Stable, version-less asset names so these deep links survive version bumps.
// macOS: TokenTrackerBar.dmg (already stable). Windows: TokenTracker-Setup.exe
// (the per-user installer; release-windows.yml uploads this alias every release).
export const MAC_DMG_URL = `${RELEASES_URL}/download/TokenTrackerBar.dmg`;
export const WIN_SETUP_URL = `${RELEASES_URL}/download/TokenTracker-Setup.exe`;

/**
 * 仪表盘/用量等：本地构建一律用空字符串（相对路径走 CLI 内置 API）。
 */
export function getBackendBaseUrl() {
  return "";
}
