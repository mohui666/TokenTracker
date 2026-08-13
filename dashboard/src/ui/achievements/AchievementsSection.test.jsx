import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AchievementsSection } from "./AchievementsSection.jsx";
import { AchievementBadge } from "./AchievementBadge.jsx";
import { BADGE_CATALOG, highestBadge, sortBadges } from "./badge-catalog.js";
import { badgeProgress } from "./achievement-format.js";

const earned = (id, tier) => ({
  id,
  tier,
  metric_value: 50,
  thresholds: [1, 10, 100, 1000],
  lower_is_better: false,
  next_threshold: tier >= 4 ? null : 100,
  achieved: { bronze: "2026-06-01T00:00:00Z", silver: null, gold: null, diamond: null },
  meta: {},
});

describe("AchievementsSection", () => {
  it("own view renders the full catalog for the scope (earned + locked)", () => {
    render(
      <AchievementsSection achievements={[earned("streak", 2)]} isOwn scope="local" />,
    );
    const localCount = BADGE_CATALOG.filter((b) => b.scope === "local").length;
    expect(localCount).toBe(13);
    expect(screen.getAllByRole("button")).toHaveLength(localCount);
  });

  it("visitor view renders earned badges only", () => {
    render(
      <AchievementsSection
        achievements={[earned("streak", 2), earned("veteran", 0)]}
        isOwn={false}
        scope="local"
      />,
    );
    expect(screen.getAllByRole("button")).toHaveLength(1);
  });

  it("visitor view with nothing earned renders nothing", () => {
    const { container } = render(
      <AchievementsSection achievements={[]} isOwn={false} scope="local" />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("tolerates a missing achievements payload (older backends)", () => {
    const { container } = render(
      <AchievementsSection achievements={undefined} isOwn={false} scope="local" />,
    );
    expect(container.firstChild).toBeNull();
  });
});

describe("AchievementBadge", () => {
  it("renders artwork for a known badge", () => {
    const { container } = render(<AchievementBadge badgeId="token_titan" tier={3} />);
    const img = container.querySelector("img");
    expect(img?.getAttribute("src")).toContain("/achievements/");
  });

  it("desaturates locked badges", () => {
    const { container } = render(<AchievementBadge badgeId="token_titan" tier={0} />);
    const img = container.querySelector("img");
    expect(img?.style.filter).toContain("grayscale");
  });

  it("gives page-scale artwork more room than the tier ring", () => {
    const { container } = render(<AchievementBadge badgeId="token_titan" tier={3} size="lg" />);
    const badge = container.firstElementChild;
    expect(badge?.style.width).toBe("108px");
    expect(badge?.style.padding).toBe("2px");
  });
});

describe("badge helpers", () => {
  it("sortBadges orders by tier desc then catalog order", () => {
    const sorted = sortBadges([
      { id: "veteran", tier: 2 },
      { id: "token_titan", tier: 2 },
      { id: "streak", tier: 4 },
    ]);
    expect(sorted.map((b) => b.id)).toEqual(["streak", "token_titan", "veteran"]);
  });

  it("highestBadge ignores unearned entries", () => {
    expect(highestBadge([{ id: "streak", tier: 0 }])).toBeNull();
    expect(highestBadge([{ id: "streak", tier: 1 }, { id: "veteran", tier: 3 }])?.id).toBe("veteran");
  });

  it("badgeProgress inverts for lower_is_better metrics and clamps", () => {
    expect(badgeProgress({ metric_value: 50, next_threshold: 100, lower_is_better: false, tier: 1 })).toBe(0.5);
    expect(
      badgeProgress({ metric_value: 60, next_threshold: 30, lower_is_better: true, tier: 1 }),
    ).toBe(0.5);
    expect(badgeProgress({ metric_value: 500, next_threshold: 100, lower_is_better: false, tier: 1 })).toBe(1);
  });
});
