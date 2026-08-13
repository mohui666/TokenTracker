import React, { useState, useCallback } from "react";
import { motion } from "motion/react";
import { ClawdAnimated } from "../../foundation/ClawdAnimated.jsx";
import { useClawdState } from "../../../hooks/useClawdState.js";

const DISMISS_KEY = "macAppBannerDismissed";
const RELEASE_URL = "https://github.com/mohui666/TokenTracker/releases/latest";

/** True when loaded inside the native macOS app (WKWebView with ?app=1) */
const NATIVE_APP_KEY = "tokentracker_native_app";
const isNativeApp = (() => {
  try {
    if (new URLSearchParams(window.location.search).get("app") === "1") {
      localStorage.setItem(NATIVE_APP_KEY, "1");
      return true;
    }
    return localStorage.getItem(NATIVE_APP_KEY) === "1";
  } catch { return false; }
})();


/**
 * Browser-only banner pointing at the native menu bar app. Inside the native
 * app itself the banner is pointless, so it renders nothing there.
 */
export function MacAppBanner({ todayTokens = 0, isSyncing = false, enterDelay = 0 }) {
  const clawdState = useClawdState({ todayTokens, isSyncing });

  const [dismissed, setDismissed] = useState(() => {
    try {
      if (localStorage.getItem(DISMISS_KEY) === "1") return true;
      if (!isNativeApp && new URLSearchParams(window.location.search).get("from") === "menubar") {
        localStorage.setItem(DISMISS_KEY, "1");
        return true;
      }
      return false;
    } catch {
      return false;
    }
  });

  const handleDismiss = useCallback(() => {
    setDismissed(true);
    try {
      localStorage.setItem(DISMISS_KEY, "1");
    } catch {
      // Ignore storage failures; the banner can reappear next session.
    }
  }, []);

  if (dismissed || isNativeApp) return null;

  const title = "Try the Menu Bar App";
  const subtitle = "Always-on stats with Clawd companion";
  const buttonLabel = "Download";

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, delay: enterDelay, ease: [0.16, 1, 0.3, 1] }}
      className="rounded-xl border border-oai-gray-200 dark:border-oai-gray-800 bg-white dark:bg-oai-gray-900 p-4"
    >
        <div className="flex items-center gap-3">
          <div className="flex-shrink-0">
            <ClawdAnimated state={clawdState} size={56} />
          </div>

          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium text-oai-gray-900 dark:text-oai-white">
              {title}
            </div>
            <div className="text-xs text-oai-gray-500 dark:text-oai-gray-400 mt-0.5">
              {subtitle}
            </div>
          </div>

          <div className="flex items-center gap-2 flex-shrink-0">
            <motion.a
              href={RELEASE_URL}
              target="_blank"
              rel="noopener noreferrer"
              whileHover={{ scale: 1.03 }}
              whileTap={{ scale: 0.97 }}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-oai-gray-900 dark:bg-oai-white dark:text-oai-gray-900 rounded-md hover:opacity-90 transition-opacity"
            >
              {buttonLabel}
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className="opacity-70">
                <path d="M6 2v6m0 0L3.5 5.5M6 8l2.5-2.5M2 10h8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </motion.a>
            <button
              onClick={handleDismiss}
              className="p-1 text-oai-gray-400 hover:text-oai-gray-600 dark:hover:text-oai-gray-300 transition-colors"
              aria-label="Dismiss"
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                <path d="M4 4l6 6m0-6L4 10" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
              </svg>
            </button>
          </div>
        </div>
    </motion.div>
  );
}
