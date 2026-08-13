import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { cn } from "../../lib/cn";
import { getDashboardEntryPath } from "../../lib/host-mode";
import { HeaderGithubStar } from "../components/HeaderGithubStar.jsx";
import { STATUSPAGE_URL } from "../../lib/config";
import { LV3_CSS_VARS } from "./v3/palette.js";
import { PRIVACY_URL, REPO_URL } from "../../lib/config";
import { HeroSection } from "./v3/HeroSection.jsx";
import { ToolsStrip } from "./v3/ToolsStrip.jsx";
import { HowItWorksSection } from "./v3/HowItWorksSection.jsx";
import { CapabilitiesSection } from "./v3/CapabilitiesSection.jsx";
import { PrivacySection } from "./v3/PrivacySection.jsx";
import { DownloadSection } from "./v3/DownloadSection.jsx";

// Local-only build: there is no community backend, so the hero counters always
// render their static fallback figures.
const STATIC_STATS = { status: "idle" };

/**
 * Landing v3 — "token galaxy". A dark, deep-space purple marketing page:
 * WebGL particle hero and GSAP ScrollTrigger storytelling. Section markup
 * lives under ./v3/; this file orchestrates them plus the header and footer.
 */
export function MarketingLanding({
  copy,
  reduceMotion,
  screenshotMode,
  effectsReady,
  installCommand,
  installCopied,
  onCopyInstallCommand,
}) {
  // One switch for every scroll/canvas animation on the page: reduced motion
  // and the visual-baseline screenshot job both get the complete static page.
  const animate = !reduceMotion && !screenshotMode;
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 10);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const stats = STATIC_STATS;
  const tokenFallback = Number(copy("landing.v3.stats.fallback_tokens")) || 0;
  const devsFallback = Number(copy("landing.v3.stats.fallback_devs")) || 0;
  const githubLabel = copy("landing.cta.secondary");

  return (
    <div
      className="relative min-h-screen overflow-x-hidden bg-[color:var(--lv3-bg)] text-oai-white font-oai antialiased dark"
      style={LV3_CSS_VARS}
    >
      <header
        className={cn(
          "sticky top-0 z-50 transition-all duration-300",
          scrolled
            ? "bg-oai-gray-950/80 backdrop-blur-md border-b border-oai-gray-900"
            : "bg-transparent border-b border-transparent",
        )}
      >
        <div className="mx-auto flex h-14 max-w-7xl items-center justify-between px-4 sm:px-6">
          <div className="flex items-center gap-3 sm:gap-5">
            <Link
              to="/"
              className="flex items-center gap-3 no-underline outline-none rounded focus-visible:ring-2 focus-visible:ring-oai-brand-500 focus-visible:ring-offset-2 dark:ring-offset-oai-gray-950 transition-opacity hover:opacity-80"
            >
              <img src="/app-icon.png" alt="" width={24} height={24} className="rounded-md" />
              <span className="whitespace-nowrap text-sm font-semibold uppercase tracking-wide text-white">
                Token Tracker
              </span>
            </Link>
            <div className="hidden sm:block">
              <HeaderGithubStar />
            </div>
          </div>
          <div className="flex items-center justify-end gap-3 sm:gap-5 md:gap-6">
            <Link
              to={getDashboardEntryPath()}
              className="inline-flex h-8 select-none items-center justify-center rounded-[8px] bg-white px-3.5 text-xs font-bold text-oai-gray-950 no-underline shadow-sm transition-all duration-200 hover:bg-oai-gray-100 active:scale-[0.98]"
            >
              {copy("landing.v2.cta.primary")}
            </Link>
          </div>
        </div>
      </header>

      <main className="-mt-14">
        <HeroSection
          copy={copy}
          animate={animate}
          effectsReady={effectsReady}
          stats={stats}
          tokenFallback={tokenFallback}
          devsFallback={devsFallback}
          installCommand={installCommand}
          installCopied={installCopied}
          onCopyInstallCommand={onCopyInstallCommand}
          githubLabel={githubLabel}
        />
        {/* Show the product first (capabilities + screenshot), enumerate the
            supported agents, THEN explain the mechanism. */}
        <CapabilitiesSection
          copy={copy}
          animate={animate}
          screenshotSrc="/dashboard-dark.png"
          screenshotAlt={copy("landing.screenshot.alt")}
        />
        <ToolsStrip copy={copy} animate={animate} />
        <HowItWorksSection copy={copy} animate={animate} />
        <PrivacySection copy={copy} animate={animate} />
        <DownloadSection
          copy={copy}
          animate={animate}
          installCommand={installCommand}
          installCopied={installCopied}
          onCopyInstallCommand={onCopyInstallCommand}
          githubLabel={githubLabel}
        />
      </main>

      <footer className="border-t border-oai-gray-900 bg-oai-gray-950 py-12">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-6 px-4 text-sm text-oai-gray-400 sm:flex-row sm:px-6">
          <p>{copy("landing.v2.footer.line")}</p>
          <div className="flex items-center gap-6">
            <a
              href={STATUSPAGE_URL}
              className="font-medium text-oai-gray-400 transition-colors hover:text-white"
              target="_blank"
              rel="noopener noreferrer"
            >
              {copy("landing.v2.nav.status")}
            </a>
            <a
              href={REPO_URL}
              className="font-medium text-oai-gray-400 transition-colors hover:text-white"
              target="_blank"
              rel="noopener noreferrer"
            >
              {copy("landing.v2.nav.github")}
            </a>
            <a
              href={PRIVACY_URL}
              className="font-medium text-oai-gray-400 transition-colors hover:text-white"
              target="_blank"
              rel="noopener noreferrer"
            >
              {copy("landing.v2.nav.privacy")}
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}
