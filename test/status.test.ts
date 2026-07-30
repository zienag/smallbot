import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  type Incident,
  type StatusState,
  formatDuration,
  formatIncidentCard,
  formatTimeline,
  formatUpdateDm,
  isCanned,
  isHighImpact,
  parseIncidents,
  pendingUpdates,
  pruneState,
  seedState,
} from "../src/status";

describe("parseIncidents", () => {
  it("parses the real fragment, newest first", () => {
    expect(incidents.map((i) => [i.id, i.impact, i.resolved])).toEqual([
      ["zftg3gqkmv18", "major", true],
      ["1019wwb67615", "none", true],
      ["vcynh9cf33xp", "critical", true],
    ]);
  });

  it("orders updates oldest first — the API returns them newest first", () => {
    expect(opus.updates.map((u) => u.status)).toEqual([
      "investigating",
      "identified",
      "identified",
      "monitoring",
      "resolved",
    ]);
  });

  it("drops the hostname parenthetical from component names", () => {
    expect(opus.components).toEqual([
      "claude.ai",
      "Claude Console",
      "Claude API",
      "Claude Code",
      "Claude Cowork",
    ]);
  });

  it("takes started_at over created_at", () => {
    expect(opus.startedAt).toBe("2026-07-26T09:17:12.688Z");
  });
});

describe("isCanned", () => {
  it("recognizes Statuspage's stock phrases", () => {
    expect(isCanned("We are currently investigating this issue.")).toBe(true);
    expect(isCanned("This incident has been resolved.")).toBe(true);
  });

  it("keeps anything a human wrote", () => {
    expect(isCanned("We are continuing to work on a fix for this issue. Haiku recovered")).toBe(
      false,
    );
  });
});

describe("formatTimeline", () => {
  it("walks the statuses with elapsed times, collapsing repeats", () => {
    // Two canned "identified" updates in a row are one state, first time kept.
    expect(formatTimeline(opus)).toBe("investigating → identified 28m → monitoring 1h 16m → resolved 1h 27m");
  });

  it("shows a lone opening status without a time", () => {
    expect(formatTimeline({ ...opus, updates: opus.updates.slice(0, 1) })).toBe("investigating");
  });
});

describe("formatIncidentCard", () => {
  it("renders header, meta, timeline — all-canned incident has no quoted text", () => {
    expect(formatIncidentCard(opus)).toBe(
      '<b><a href="https://stspg.io/jrz1yk46f9xp">Elevated errors for Opus 5</a></b>\n' +
        "major · claude.ai, Claude Console, Claude API, Claude Code, Claude Cowork\n\n" +
        "investigating → identified 28m → monitoring 1h 16m → resolved 1h 27m",
    );
  });

  it("quotes bespoke text and omits the empty meta line", () => {
    const [, blip] = incidents;
    expect(formatIncidentCard(blip)).toBe(
      '<b><a href="https://stspg.io/ty4xl4702q4r">Sonnet 4.6 and Sonnet 5 errors elevated</a></b>\n\n' +
        "resolved\n\n" +
        "For approximately 10 minutes, error rates on Sonnet 4.6 and 5 were elevated. " +
        "Service returned to normal at approximately 11:07a PDT.",
    );
  });

  it("keeps every bespoke paragraph on a mixed incident", () => {
    const [, , critical] = incidents;
    const card = formatIncidentCard(critical);
    expect(card).toContain("investigating → identified 16m → monitoring 1h 32m → resolved 2h 43m");
    expect(card).toContain("From 8:28am PT / 15:28 UTC through 9:26am PT / 16:26 UTC");
  });

  it("escapes incident text", () => {
    const card = formatIncidentCard({
      ...opus,
      name: "<b>oops</b>",
      updates: [{ ...opus.updates[0], body: "a & b" }],
    });
    expect(card).toContain("&lt;b&gt;oops&lt;/b&gt;");
    expect(card).toContain("a &amp; b");
  });
});

describe("formatUpdateDm", () => {
  it("stands alone: incident name, status with elapsed, body", () => {
    expect(formatUpdateDm(opus, opus.updates[1])).toBe(
      "<b>Elevated errors for Opus 5</b>\n<b>identified</b> · 28m in\n" +
        "The issue has been identified and a fix is being implemented.",
    );
  });

  it("marks the resolution with the total duration", () => {
    expect(formatUpdateDm(opus, opus.updates[4])).toBe(
      "<b>Elevated errors for Opus 5</b>\n<b>resolved</b> · 1h 27m total\n" +
        "This incident has been resolved.",
    );
  });
});

describe("formatDuration", () => {
  it("keeps minutes under an hour", () => {
    expect(formatDuration(0)).toBe("0m");
    expect(formatDuration(42 * MINUTE)).toBe("42m");
  });

  it("drops empty units", () => {
    expect(formatDuration(60 * MINUTE)).toBe("1h");
    expect(formatDuration(87 * MINUTE)).toBe("1h 27m");
    expect(formatDuration(48 * 60 * MINUTE)).toBe("2d");
    expect(formatDuration(51 * 60 * MINUTE)).toBe("2d 3h");
  });
});

describe("isHighImpact", () => {
  it("covers major and critical only", () => {
    expect(incidents.map(isHighImpact)).toEqual([true, false, true]);
  });
});

describe("state", () => {
  it("seeds every update as posted, with no card message", () => {
    const state = seedState(incidents);
    expect(state[opus.id]).toEqual({
      messageId: 0,
      postedUpdates: opus.updates.map((u) => u.id),
    });
    expect(pendingUpdates(state, opus)).toEqual([]);
  });

  it("treats an unknown incident as fully pending", () => {
    expect(pendingUpdates({}, opus)).toEqual(opus.updates);
  });

  it("returns only unposted updates, in order", () => {
    const state: StatusState = {
      [opus.id]: { messageId: 7, postedUpdates: [opus.updates[0].id, opus.updates[1].id] },
    };
    expect(pendingUpdates(state, opus).map((u) => u.status)).toEqual([
      "identified",
      "monitoring",
      "resolved",
    ]);
  });

  it("prunes incidents that fell out of the feed window", () => {
    const state = { ...seedState(incidents), gone: { messageId: 1, postedUpdates: [] } };
    expect(Object.keys(pruneState(state, incidents)).sort()).toEqual(
      incidents.map((i) => i.id).sort(),
    );
  });
});

const MINUTE = 60_000;
const incidents: Incident[] = parseIncidents(
  readFileSync("test/fixtures-status-incidents.json", "utf8"),
);
const opus = incidents[0];
