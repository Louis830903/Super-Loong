/**
 * Evolution Engine — Comprehensive Tests.
 *
 * Covers: CaseCollector, NudgeTracker, EvolutionEngine partial tests.
 */
import { describe, it, expect, vi } from "vitest";
import { CaseCollector, NudgeTracker, type InteractionCase } from "../evolution/engine.js";

// ─── CaseCollector ─────────────────────────────────────────
describe("CaseCollector", () => {
  function makeCase(overrides: Partial<InteractionCase> = {}): InteractionCase {
    return {
      id: `case-${Math.random().toString(36).slice(2, 8)}`,
      agentId: "agent-1",
      sessionId: "sess-1",
      userMessage: "test message",
      agentResponse: "test response",
      toolCalls: [],
      success: true,
      timestamp: new Date(),
      ...overrides,
    };
  }

  it("should add and retrieve cases", () => {
    const collector = new CaseCollector();
    collector.addCase(makeCase({ id: "c1" }));
    collector.addCase(makeCase({ id: "c2" }));

    const all = collector.getAllCases();
    expect(all.length).toBe(2);
  });

  it("should filter failure cases", () => {
    const collector = new CaseCollector();
    collector.addCase(makeCase({ id: "ok", success: true }));
    collector.addCase(makeCase({ id: "fail1", success: false, failureReason: "timeout" }));
    collector.addCase(makeCase({ id: "fail2", success: false, failureCategory: "skill_gap" }));

    const failures = collector.getFailureCases();
    expect(failures.length).toBe(2);
    expect(failures.every((c) => !c.success)).toBe(true);
  });

  it("should categorize failures", () => {
    const collector = new CaseCollector();
    collector.addCase(makeCase({ id: "f1", success: false, failureCategory: "skill_gap" }));
    collector.addCase(makeCase({ id: "f2", success: false, failureCategory: "skill_gap" }));
    collector.addCase(makeCase({ id: "f3", success: false, failureCategory: "wrong_tool" }));

    const byCategory = collector.getFailuresByCategory();
    expect(byCategory.get("skill_gap")?.length).toBe(2);
    expect(byCategory.get("wrong_tool")?.length).toBe(1);
  });

  it("should enforce maxCases capacity", () => {
    const collector = new CaseCollector(5, 48);
    for (let i = 0; i < 10; i++) {
      collector.addCase(makeCase({ id: `cap-${i}` }));
    }
    expect(collector.getAllCases().length).toBeLessThanOrEqual(5);
  });

  it("should prune old cases by time window", () => {
    const collector = new CaseCollector(200, 1); // 1-hour window
    // Add case from 2 hours ago
    collector.addCase(makeCase({
      id: "old",
      timestamp: new Date(Date.now() - 2 * 60 * 60 * 1000),
    }));
    // Add recent case — triggers prune
    collector.addCase(makeCase({ id: "recent" }));

    const all = collector.getAllCases();
    expect(all.find((c) => c.id === "old")).toBeUndefined();
    expect(all.find((c) => c.id === "recent")).toBeDefined();
  });

  it("should update existing case by id", () => {
    const collector = new CaseCollector();
    collector.addCase(makeCase({ id: "update-me", success: true }));
    collector.addCase(makeCase({ id: "update-me", success: false, failureReason: "updated" }));

    const all = collector.getAllCases();
    const updated = all.find((c) => c.id === "update-me");
    expect(updated?.success).toBe(false);
    expect(updated?.failureReason).toBe("updated");
  });

  it("should report stats", () => {
    const collector = new CaseCollector();
    collector.addCase(makeCase({ id: "s1", success: true, score: 0.9 }));
    collector.addCase(makeCase({ id: "s2", success: false, score: 0.3 }));
    collector.addCase(makeCase({ id: "s3", success: true, score: 0.8 }));

    const stats = collector.getStats();
    expect(stats.total).toBe(3);
    expect(stats.failures).toBe(1);
    expect(stats.successRate).toBeCloseTo(2 / 3, 1);
    expect(stats.avgScore).toBeGreaterThan(0);
  });
});

// ─── NudgeTracker ──────────────────────────────────────────
describe("NudgeTracker", () => {
  it("should create with default config", () => {
    const tracker = new NudgeTracker();
    const config = tracker.getConfig();
    expect(config.memoryReviewInterval).toBeGreaterThan(0);
    expect(config.skillReviewInterval).toBeGreaterThan(0);
  });

  it("should create with custom config", () => {
    const tracker = new NudgeTracker({
      memoryReviewInterval: 5,
      skillReviewInterval: 3,
      combinedReview: true,
    });
    const config = tracker.getConfig();
    expect(config.memoryReviewInterval).toBe(5);
    expect(config.skillReviewInterval).toBe(3);
  });

  it("should track conversation turns", () => {
    const tracker = new NudgeTracker({ memoryReviewInterval: 3 });
    tracker.recordTurn();
    tracker.recordTurn();
    const check2 = tracker.recordTurn(); // 3rd turn should trigger
    expect(check2.shouldReviewMemory).toBe(true);
  });

  it("should track tool iterations", () => {
    const tracker = new NudgeTracker({ skillReviewInterval: 2 });
    tracker.recordToolIteration();
    const check = tracker.recordToolIteration(); // 2nd iteration
    expect(check.shouldReviewSkills).toBe(true);
  });

  it("should reset skill counter", () => {
    const tracker = new NudgeTracker({ skillReviewInterval: 2 });
    tracker.recordToolIteration();
    tracker.resetSkillCounter();
    const check = tracker.recordToolIteration(); // only 1st after reset
    expect(check.shouldReviewSkills).toBe(false);
  });

  it("should provide stats", () => {
    const tracker = new NudgeTracker();
    tracker.recordTurn();
    tracker.recordTurn();
    tracker.recordToolIteration();

    const stats = tracker.getStats();
    expect(stats.totalTurns).toBe(2);
    expect(stats.totalToolIterations).toBe(1);
  });
});

// ─── Stress: Many Cases ────────────────────────────────────
describe("CaseCollector Stress Test", () => {
  it("should handle 500 rapid case additions", () => {
    const collector = new CaseCollector(300, 48);
    const start = performance.now();

    for (let i = 0; i < 500; i++) {
      collector.addCase({
        id: `stress-${i}`,
        agentId: "agent-1",
        sessionId: `sess-${i % 10}`,
        userMessage: `question ${i}`,
        agentResponse: `answer ${i}`,
        toolCalls: ["tool-a", "tool-b"],
        success: i % 3 !== 0,
        score: Math.random(),
        failureCategory: i % 3 === 0 ? "skill_gap" : undefined,
        timestamp: new Date(),
      });
    }

    const elapsed = performance.now() - start;
    const all = collector.getAllCases();

    // Should be capped at maxCases
    expect(all.length).toBeLessThanOrEqual(300);
    // Should be fast
    expect(elapsed).toBeLessThan(1000);
  });
});
