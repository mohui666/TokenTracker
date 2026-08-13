import React, { useMemo, useState } from "react";
import { useAchievements } from "../hooks/use-achievements.js";
import { copy } from "../lib/copy";
import { AchievementsSection } from "../ui/achievements/AchievementsSection.jsx";
import { BADGE_CATALOG } from "../ui/achievements/badge-catalog.js";

// Lazy: 3D coin + dialog ship only when a badge is clicked.
const BadgeDetailModal = React.lazy(() => import("../ui/achievements/BadgeDetailModal.jsx"));

function GridSkeleton() {
  // Mirrors AchievementsSection's wide layout 1:1 so content pops in with
  // zero shift.
  return (
    <div
      className="mx-0 grid animate-pulse grid-cols-[repeat(3,max-content)] justify-between gap-y-7 sm:-mx-2 sm:grid-cols-[repeat(4,max-content)] lg:grid-cols-[repeat(5,max-content)]"
      aria-hidden
    >
      {Array.from({ length: BADGE_CATALOG.length }).map((_, index) => (
        <div key={index} className="flex w-[6.75rem] flex-col items-center px-0 pb-3 pt-4 sm:w-[7.75rem]">
          <div className="h-[108px] w-[108px] rounded-full bg-oai-gray-200 dark:bg-oai-gray-800" />
          <div className="mt-3 h-3 w-16 rounded bg-oai-gray-200 dark:bg-oai-gray-800" />
          <div className="mt-2 h-2 w-10 rounded bg-oai-gray-100 dark:bg-oai-gray-800/60" />
        </div>
      ))}
    </div>
  );
}

export default function AchievementsPage() {
  const local = useAchievements();
  const [selectedBadge, setSelectedBadge] = useState(null);
  const loading = local.status === "loading";

  // All badges are computed locally by the CLI endpoint — a single flat list.
  const merged = useMemo(() => local.achievements || [], [local.achievements]);
  const earnedCount = useMemo(
    () => merged.filter((b) => (b?.tier || 0) >= 1).length,
    [merged],
  );
  const total = BADGE_CATALOG.length;

  return (
    <div className="flex flex-1 flex-col font-oai text-oai-black antialiased dark:text-oai-white">
      <main className="flex-1 pb-12 pt-8 sm:pb-16 sm:pt-10">
        <div className="mx-auto max-w-4xl px-4 sm:px-6">
          {/* items-baseline: the 12/12 figure sits on the SAME baseline as
              the page title — the two big text elements read as one line. */}
          <div className="mb-7 flex items-baseline justify-between gap-4">
            <div className="min-w-0">
              <h1 className="text-3xl font-semibold tracking-tight text-oai-black dark:text-white sm:text-4xl">
                {copy("achievements.page.title")}
              </h1>
              <p className="mt-1.5 text-sm text-oai-gray-500 dark:text-oai-gray-400">
                {copy("achievements.page.local_note")}
              </p>
            </div>
            {!loading && (
              <div className="shrink-0 text-right">
                <div className="font-mono text-2xl font-semibold leading-none tabular-nums text-oai-black dark:text-white">
                  {earnedCount}
                  <span className="text-oai-gray-400 dark:text-oai-gray-600">/{total}</span>
                </div>
                <div className="mt-2 h-1 w-24 overflow-hidden rounded-full bg-oai-gray-200 dark:bg-oai-gray-800">
                  <div
                    className="h-full rounded-full bg-oai-brand-600 transition-[width] duration-500"
                    style={{ width: `${Math.round((earnedCount / total) * 100)}%` }}
                  />
                </div>
              </div>
            )}
          </div>

          {loading ? (
            <GridSkeleton />
          ) : (
            <>
              <AchievementsSection
                achievements={merged}
                isOwn
                columns="wide"
                size="lg"
                animateIn
                onSelect={setSelectedBadge}
              />
              <p className="mt-10 text-center text-xs text-oai-gray-400 dark:text-oai-gray-500">
                {copy("achievements.page.suggest")}{" "}
                <a
                  href="https://github.com/mohui666/TokenTracker/issues"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline decoration-oai-gray-300 underline-offset-2 transition-colors hover:text-oai-gray-700 hover:decoration-oai-gray-500 dark:decoration-oai-gray-600 dark:hover:text-oai-gray-300"
                >
                  {copy("achievements.page.suggest_link")}
                </a>
              </p>
            </>
          )}
        </div>
      </main>

      {selectedBadge && (
        <React.Suspense fallback={null}>
          <BadgeDetailModal badge={selectedBadge} onClose={() => setSelectedBadge(null)} />
        </React.Suspense>
      )}
    </div>
  );
}
