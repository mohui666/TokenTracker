const assert = require("node:assert/strict");
const { test } = require("node:test");

const { computeLocalAchievements, LOCAL_BADGE_THRESHOLDS } = require("../src/lib/local-api");

const TZ_SHANGHAI = { timeZone: "Asia/Shanghai", offsetMinutes: 480 };
const TZ_UTC = { timeZone: "UTC", offsetMinutes: 0 };

const EXPECTED_BADGE_IDS = [
  "token_titan",
  "big_day",
  "wordsmith",
  "marathoner",
  "streak",
  "weekend_warrior",
  "momentum",
  "polyglot",
  "multitool",
  "veteran",
  "project_hopper",
  "project_devotion",
  "night_owl",
];

function projectRow(projectKey, hourStart, tokens) {
  return { project_key: projectKey, source: "claude", hour_start: hourStart, total_tokens: tokens };
}

function queueRow(hourStart, tokens, extra = {}) {
  return { source: "claude", model: "m", hour_start: hourStart, total_tokens: tokens, ...extra };
}

function byId(result, id) {
  return result.find((badge) => badge.id === id);
}

test("empty inputs yield the full locked catalog", () => {
  const result = computeLocalAchievements([], [], { timeZoneContext: TZ_SHANGHAI });
  assert.equal(result.length, 13);
  assert.deepEqual(result.map((b) => b.id), EXPECTED_BADGE_IDS);
  for (const badge of result) {
    assert.equal(badge.tier, 0);
    assert.equal(badge.metric_value, 0);
    assert.equal(badge.next_threshold, badge.thresholds[0]);
    assert.deepEqual(Object.values(badge.achieved), [null, null, null, null]);
  }
});

test("payload shape matches the dashboard contract for every badge", () => {
  const result = computeLocalAchievements(
    [queueRow("2026-07-01T10:00:00Z", 100)],
    [],
    { timeZoneContext: TZ_UTC },
  );
  for (const badge of result) {
    assert.deepEqual(Object.keys(badge).sort(), [
      "achieved",
      "id",
      "lower_is_better",
      "meta",
      "metric_value",
      "next_threshold",
      "thresholds",
      "tier",
    ]);
    assert.equal(badge.thresholds.length, 4);
    assert.equal(badge.lower_is_better, false);
    assert.equal(typeof badge.meta, "object");
  }
});

test("project_hopper tiers on distinct projects with boundary exactness", () => {
  const [bronze] = [LOCAL_BADGE_THRESHOLDS.project_hopper[0]];
  const below = Array.from({ length: bronze - 1 }, (_, i) =>
    projectRow(`p${i}`, `2026-07-0${i + 1}T10:00:00Z`, 100),
  );
  const under = byId(
    computeLocalAchievements([], below, { timeZoneContext: TZ_SHANGHAI }),
    "project_hopper",
  );
  assert.equal(under.tier, 0);

  const exact = [...below, projectRow(`p${bronze}`, "2026-07-09T10:00:00Z", 100)];
  const at = byId(
    computeLocalAchievements([], exact, { timeZoneContext: TZ_SHANGHAI }),
    "project_hopper",
  );
  assert.equal(at.tier, 1);
  // achieved timestamp = hour the crossing row landed
  assert.equal(at.achieved.bronze, "2026-07-09T10:00:00Z");
  assert.equal(at.metric_value, bronze);
});

test("project_devotion tracks the max single-project running total", () => {
  const rows = [
    projectRow("small", "2026-07-01T01:00:00Z", 400_000),
    projectRow("big", "2026-07-02T01:00:00Z", 600_000),
    projectRow("big", "2026-07-03T01:00:00Z", 500_000), // big crosses 1M here
  ];
  const badge = byId(
    computeLocalAchievements([], rows, { timeZoneContext: TZ_SHANGHAI }),
    "project_devotion",
  );
  assert.equal(badge.tier, 1);
  assert.equal(badge.metric_value, 1_100_000);
  assert.equal(badge.achieved.bronze, "2026-07-03T01:00:00Z");
  assert.equal(badge.meta.project_key, "big");
});

test("night_owl buckets hours in the caller's timezone, not UTC", () => {
  // 18:00–22:00 UTC = 02:00–06:00 Asia/Shanghai (only <06:00 counts → 4 rows).
  const night = [
    queueRow("2026-07-01T18:00:00Z", 10), // 02:00 local
    queueRow("2026-07-01T19:00:00Z", 10), // 03:00
    queueRow("2026-07-01T20:00:00Z", 10), // 04:00
    queueRow("2026-07-01T21:00:00Z", 10), // 05:00
    queueRow("2026-07-01T22:00:00Z", 10), // 06:00 — NOT night
    queueRow("2026-07-01T10:00:00Z", 10), // 18:00 — NOT night
  ];
  const badge = byId(
    computeLocalAchievements(night, [], { timeZoneContext: TZ_SHANGHAI }),
    "night_owl",
  );
  assert.equal(badge.metric_value, 4);
  assert.equal(badge.tier, 0); // bronze needs 5

  // One more genuine night hour crosses bronze.
  const crossed = byId(
    computeLocalAchievements(
      [...night, queueRow("2026-07-02T17:00:00Z", 10)], // 01:00 local next day
      [],
      { timeZoneContext: TZ_SHANGHAI },
    ),
    "night_owl",
  );
  assert.equal(crossed.tier, 1);
  assert.equal(crossed.metric_value, 5);
});

test("zero-token rows never count anywhere", () => {
  const result = computeLocalAchievements(
    [queueRow("2026-07-01T18:00:00Z", 0)],
    [projectRow("p1", "2026-07-01T10:00:00Z", 0)],
    { timeZoneContext: TZ_SHANGHAI },
  );
  for (const badge of result) {
    assert.equal(badge.tier, 0);
    assert.equal(badge.metric_value, 0);
  }
});

test("tier timestamps replay in hour order even when rows arrive shuffled", () => {
  const thresholds = LOCAL_BADGE_THRESHOLDS.project_hopper;
  const rows = [];
  for (let i = 0; i < thresholds[1]; i += 1) {
    rows.push(projectRow(`p${i}`, `2026-06-${String(i + 1).padStart(2, "0")}T08:00:00Z`, 50));
  }
  const shuffled = [rows[4], rows[0], rows[3], rows[1], rows[2]];
  const badge = byId(
    computeLocalAchievements([], shuffled, { timeZoneContext: TZ_SHANGHAI }),
    "project_hopper",
  );
  assert.equal(badge.tier, 2);
  // bronze crossed on the 3rd distinct project chronologically, silver on the 5th.
  assert.equal(badge.achieved.bronze, "2026-06-03T08:00:00Z");
  assert.equal(badge.achieved.silver, "2026-06-05T08:00:00Z");
});

test("token_titan accumulates lifetime tokens and stamps the crossing bucket", () => {
  const rows = [
    queueRow("2026-07-01T10:00:00Z", 60_000_000),
    queueRow("2026-07-02T10:00:00Z", 30_000_000), // 90M — still below bronze
    queueRow("2026-07-03T10:00:00Z", 20_000_000), // 110M — crosses bronze (100M)
  ];
  const badge = byId(
    computeLocalAchievements(rows, [], { timeZoneContext: TZ_UTC }),
    "token_titan",
  );
  assert.equal(badge.metric_value, 110_000_000);
  assert.equal(badge.tier, 1);
  assert.equal(badge.achieved.bronze, "2026-07-03T10:00:00Z");
  assert.equal(badge.achieved.silver, null);
  assert.equal(badge.next_threshold, 1_000_000_000);
});

test("wordsmith sums output tokens only", () => {
  const rows = [
    queueRow("2026-07-01T10:00:00Z", 50_000_000, { output_tokens: 4_000_000 }),
    queueRow("2026-07-02T10:00:00Z", 50_000_000, { output_tokens: 2_000_000 }), // crosses 5M
  ];
  const badge = byId(
    computeLocalAchievements(rows, [], { timeZoneContext: TZ_UTC }),
    "wordsmith",
  );
  assert.equal(badge.metric_value, 6_000_000);
  assert.equal(badge.tier, 1);
  assert.equal(badge.achieved.bronze, "2026-07-02T10:00:00Z");
});

test("big_day keeps the best single local day and its date", () => {
  const rows = [
    queueRow("2026-07-01T10:00:00Z", 8_000_000),
    queueRow("2026-07-01T11:00:00Z", 5_000_000), // 13M on Jul 1 → bronze
    queueRow("2026-07-02T10:00:00Z", 9_000_000),
  ];
  const badge = byId(
    computeLocalAchievements(rows, [], { timeZoneContext: TZ_UTC }),
    "big_day",
  );
  assert.equal(badge.metric_value, 13_000_000);
  assert.equal(badge.tier, 1);
  assert.equal(badge.meta.date, "2026-07-01");
  // Day-grain badges stamp the day's first contributing bucket.
  assert.equal(badge.achieved.bronze, "2026-07-01T10:00:00Z");
});

test("marathoner counts distinct active local days", () => {
  const rows = [
    queueRow("2026-07-01T08:00:00Z", 100),
    queueRow("2026-07-01T09:00:00Z", 100), // same day — no extra count
    queueRow("2026-07-03T08:00:00Z", 100),
  ];
  const badge = byId(
    computeLocalAchievements(rows, [], { timeZoneContext: TZ_UTC }),
    "marathoner",
  );
  assert.equal(badge.metric_value, 2);
  assert.equal(badge.tier, 0); // bronze needs 7
});

test("streak tracks the longest consecutive local-day run with its span", () => {
  const rows = [
    queueRow("2026-07-01T10:00:00Z", 100),
    queueRow("2026-07-02T10:00:00Z", 100),
    queueRow("2026-07-03T10:00:00Z", 100), // 3-day run → bronze
    queueRow("2026-07-10T10:00:00Z", 100), // gap resets the run
    queueRow("2026-07-11T10:00:00Z", 100),
  ];
  const badge = byId(
    computeLocalAchievements(rows, [], { timeZoneContext: TZ_UTC }),
    "streak",
  );
  assert.equal(badge.metric_value, 3);
  assert.equal(badge.tier, 1);
  assert.equal(badge.achieved.bronze, "2026-07-03T10:00:00Z");
  assert.deepEqual(badge.meta, { run_start: "2026-07-01", run_end: "2026-07-03" });
});

test("weekend_warrior buckets weekend days in the caller's timezone", () => {
  // 2026-07-06T01:00:00Z is Monday UTC but Sunday 20:00 in UTC-5.
  const rows = [queueRow("2026-07-06T01:00:00Z", 100)];
  const utc = byId(
    computeLocalAchievements(rows, [], { timeZoneContext: TZ_UTC }),
    "weekend_warrior",
  );
  assert.equal(utc.metric_value, 0);

  const chicago = byId(
    computeLocalAchievements(rows, [], {
      timeZoneContext: { timeZone: "America/Chicago", offsetMinutes: -300 },
    }),
    "weekend_warrior",
  );
  assert.equal(chicago.metric_value, 1);
});

test("momentum requires adjacent ISO weeks and a 10M prior-week floor", () => {
  // Week of Mon 2026-07-06: 12M; week of Mon 2026-07-13: 30M → ratio 2.5.
  const rows = [
    queueRow("2026-07-06T10:00:00Z", 12_000_000),
    queueRow("2026-07-13T10:00:00Z", 30_000_000),
  ];
  const badge = byId(
    computeLocalAchievements(rows, [], { timeZoneContext: TZ_UTC }),
    "momentum",
  );
  assert.equal(badge.metric_value, 2.5);
  assert.equal(badge.tier, 1);
  assert.equal(badge.meta.week, "2026-07-13");
  assert.equal(badge.achieved.bronze, "2026-07-13T10:00:00Z");

  // Prior week under the 10M floor → no ratio at all.
  const belowFloor = byId(
    computeLocalAchievements(
      [
        queueRow("2026-07-06T10:00:00Z", 5_000_000),
        queueRow("2026-07-13T10:00:00Z", 500_000_000),
      ],
      [],
      { timeZoneContext: TZ_UTC },
    ),
    "momentum",
  );
  assert.equal(belowFloor.metric_value, 0);
  assert.equal(belowFloor.tier, 0);

  // Non-adjacent weeks (empty week in between) → no ratio.
  const gap = byId(
    computeLocalAchievements(
      [
        queueRow("2026-07-06T10:00:00Z", 12_000_000),
        queueRow("2026-07-27T10:00:00Z", 60_000_000),
      ],
      [],
      { timeZoneContext: TZ_UTC },
    ),
    "momentum",
  );
  assert.equal(gap.metric_value, 0);
});

test("polyglot counts distinct models and reports the favorite", () => {
  const rows = ["m1", "m2", "m3", "m4"].flatMap((model, i) => [
    queueRow(`2026-07-0${i + 1}T10:00:00Z`, 100, { model }),
  ]);
  const under = byId(
    computeLocalAchievements(rows, [], { timeZoneContext: TZ_UTC }),
    "polyglot",
  );
  assert.equal(under.metric_value, 4);
  assert.equal(under.tier, 0); // bronze needs 5

  const crossed = byId(
    computeLocalAchievements(
      [...rows, queueRow("2026-07-05T10:00:00Z", 999, { model: "m5" })],
      [],
      { timeZoneContext: TZ_UTC },
    ),
    "polyglot",
  );
  assert.equal(crossed.tier, 1);
  assert.equal(crossed.metric_value, 5);
  assert.equal(crossed.achieved.bronze, "2026-07-05T10:00:00Z");
  assert.equal(crossed.meta.favorite_model, "m5");
});

test("multitool counts distinct sources", () => {
  const rows = [
    queueRow("2026-07-01T10:00:00Z", 100, { source: "claude" }),
    queueRow("2026-07-01T11:00:00Z", 100, { source: "codex" }),
    queueRow("2026-07-01T12:00:00Z", 100, { source: "codex" }),
  ];
  const badge = byId(
    computeLocalAchievements(rows, [], { timeZoneContext: TZ_UTC }),
    "multitool",
  );
  assert.equal(badge.metric_value, 2);
  assert.equal(badge.tier, 1); // bronze = 2 tools
  assert.equal(badge.achieved.bronze, "2026-07-01T11:00:00Z");
});

test("veteran measures days since the first active local day", () => {
  const rows = [queueRow("2020-01-01T10:00:00Z", 100)];
  const badge = byId(
    computeLocalAchievements(rows, [], { timeZoneContext: TZ_UTC }),
    "veteran",
  );
  assert.ok(badge.metric_value > 365, `expected >365 days, got ${badge.metric_value}`);
  assert.equal(badge.tier, 4);
  assert.equal(badge.meta.first_day, "2020-01-01");
  assert.equal(badge.achieved.bronze, "2020-01-31T00:00:00Z");
  assert.equal(badge.next_threshold, null);
});
