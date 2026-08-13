// Display metadata for the achievement catalog.
//
// Thresholds do NOT live here — the local CLI (local-api) returns per-badge
// thresholds + next_threshold in its payload, and
// test/user-badges-thresholds-single-source.test.js enforces that no
// threshold literals appear in dashboard code. Array order = display order.
import {
  Blocks,
  Brain,
  CalendarDays,
  Crown,
  Feather,
  Flame,
  FolderGit2,
  Footprints,
  Heart,
  MoonStar,
  ShieldCheck,
  TrendingUp,
  Zap,
} from "lucide-react";

// `art` files live in dashboard/public/achievements/ (see the README there
// for provenance); the lucide `icon` is the render fallback if the art fails
// to load.
export const BADGE_CATALOG = [
  { id: "token_titan", scope: "local", icon: Crown, format: "tokens", art: "/achievements/token-titan.png" },
  { id: "big_day", scope: "local", icon: Zap, format: "tokens", art: "/achievements/big-day.png" },
  { id: "wordsmith", scope: "local", icon: Feather, format: "tokens", art: "/achievements/wordsmith.png" },
  { id: "marathoner", scope: "local", icon: Footprints, format: "days", art: "/achievements/marathoner.png" },
  { id: "streak", scope: "local", icon: Flame, format: "days", art: "/achievements/streak.png" },
  { id: "weekend_warrior", scope: "local", icon: CalendarDays, format: "days", art: "/achievements/weekend-warrior.png" },
  { id: "momentum", scope: "local", icon: TrendingUp, format: "multiplier", art: "/achievements/momentum.png" },
  { id: "polyglot", scope: "local", icon: Brain, format: "count", art: "/achievements/polyglot.png" },
  { id: "multitool", scope: "local", icon: Blocks, format: "count", art: "/achievements/multitool.png" },
  { id: "veteran", scope: "local", icon: ShieldCheck, format: "days", art: "/achievements/veteran.png" },
  { id: "project_hopper", scope: "local", icon: FolderGit2, format: "count", art: "/achievements/project-hopper.png" },
  { id: "project_devotion", scope: "local", icon: Heart, format: "tokens", art: "/achievements/project-devotion.png" },
  { id: "night_owl", scope: "local", icon: MoonStar, format: "count", art: "/achievements/night-owl.png" },
];

export const BADGE_BY_ID = new Map(BADGE_CATALOG.map((b) => [b.id, b]));

const CATALOG_INDEX = new Map(BADGE_CATALOG.map((b, i) => [b.id, i]));

export function badgeCopyKey(badgeId, slot) {
  return `achievements.badge.${badgeId}.${slot}`;
}

/** Sort earned badges by tier desc, then catalog order. */
export function sortBadges(badges) {
  return [...(badges || [])].sort((a, b) => {
    const tierDiff = (b?.tier || 0) - (a?.tier || 0);
    if (tierDiff !== 0) return tierDiff;
    return (CATALOG_INDEX.get(a?.id) ?? 99) - (CATALOG_INDEX.get(b?.id) ?? 99);
  });
}

/** Highest-priority earned badge (tier desc, catalog order tie-break). */
export function highestBadge(badges) {
  const earned = (badges || []).filter((b) => b && (b.tier || 0) >= 1 && BADGE_BY_ID.has(b.id));
  if (earned.length === 0) return null;
  return sortBadges(earned)[0];
}
