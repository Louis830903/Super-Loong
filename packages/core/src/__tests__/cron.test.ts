/**
 * Cron Scheduler — Comprehensive Tests.
 *
 * Covers: CronScheduler lifecycle, cron-parser integration, natural language parsing.
 */
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs";
import { CronScheduler, parseNaturalLanguageToCron } from "../cron/index.js";
import { initDatabase, closeDatabase, loadCronJobs } from "../persistence/sqlite.js";

const TEST_DB_PATH = path.join(process.cwd(), "data", "test-cron.db");

beforeAll(async () => {
  if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
  await initDatabase(TEST_DB_PATH);
});

afterAll(() => {
  closeDatabase();
  if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
});

describe("CronScheduler", () => {
  let scheduler: CronScheduler;

  afterEach(() => {
    if (scheduler) scheduler.stop();
  });

  it("should create scheduler and add a job", () => {
    scheduler = new CronScheduler();
    const job = scheduler.addJob({
      name: "Test Job",
      expression: "*/5 * * * *",
      agentId: "agent-1",
      message: "run test",
    });

    expect(job.id).toBeDefined();
    expect(job.name).toBe("Test Job");
    expect(job.enabled).toBe(true);

    const jobs = scheduler.listJobs();
    expect(jobs.length).toBe(1);
  });

  it("should get job by id", () => {
    scheduler = new CronScheduler();
    const job = scheduler.addJob({
      name: "Lookup Test",
      expression: "0 0 * * *",
      agentId: "agent-1",
      message: "daily task",
    });

    const found = scheduler.getJob(job.id);
    expect(found).toBeDefined();
    expect(found!.name).toBe("Lookup Test");
  });

  it("should remove a job", () => {
    scheduler = new CronScheduler();
    const job = scheduler.addJob({
      name: "To Remove",
      expression: "0 * * * *",
      agentId: "agent-1",
      message: "hourly",
    });

    expect(scheduler.removeJob(job.id)).toBe(true);
    expect(scheduler.listJobs().length).toBe(0);
    expect(scheduler.removeJob("non-existent")).toBe(false);
  });

  it("should update a job", () => {
    scheduler = new CronScheduler();
    const job = scheduler.addJob({
      name: "Old Name",
      expression: "0 * * * *",
      agentId: "agent-1",
      message: "msg",
    });

    const updated = scheduler.updateJob(job.id, { name: "New Name", enabled: false });
    expect(updated).not.toBeNull();
    expect(updated!.name).toBe("New Name");
    expect(updated!.enabled).toBe(false);
  });

  it("should handle full 5-field cron expressions", () => {
    scheduler = new CronScheduler();
    // Day-of-month, month, day-of-week fields
    const job = scheduler.addJob({
      name: "Complex Cron",
      expression: "30 14 1 */2 1-5",
      agentId: "agent-1",
      message: "complex schedule",
    });

    expect(job.nextRunAt).toBeDefined();
  });

  it("should handle alias expressions", () => {
    scheduler = new CronScheduler();
    const aliases = ["@hourly", "@daily", "@weekly", "@monthly", "@yearly"];
    for (const alias of aliases) {
      const job = scheduler.addJob({
        name: `Alias ${alias}`,
        expression: alias,
        agentId: "agent-1",
        message: "alias test",
      });
      expect(job.nextRunAt).toBeDefined();
      scheduler.removeJob(job.id);
    }
  });

  it("should start and stop scheduler", () => {
    scheduler = new CronScheduler();
    scheduler.addJob({
      name: "Running Job",
      expression: "*/1 * * * *",
      agentId: "agent-1",
      message: "every minute",
    });

    scheduler.start(() => async () => "done");
    expect(scheduler.isRunning).toBe(true);

    scheduler.stop();
    expect(scheduler.isRunning).toBe(false);
  });

  it("should persist jobs to database", () => {
    scheduler = new CronScheduler();
    scheduler.addJob({
      name: "Persisted Job",
      expression: "0 9 * * *",
      agentId: "agent-1",
      message: "morning check",
    });

    const dbJobs = loadCronJobs();
    const found = dbJobs.find((j) => j.name === "Persisted Job");
    expect(found).toBeDefined();
  });
});

describe("Cron Expression Parsing (cron-parser)", () => {
  it("should parse standard 5-field cron expressions", () => {
    const scheduler = new CronScheduler();
    // These should all create valid jobs with nextRunAt
    const expressions = [
      "* * * * *",      // every minute
      "0 */2 * * *",    // every 2 hours
      "30 9 * * 1",     // 9:30 on Monday
      "0 0 1 * *",      // midnight on 1st of month
      "15 14 1 * *",    // 2:15pm on 1st of month
      "0 22 * * 1-5",   // 10pm weekdays
      "0 0 15 */3 *",   // midnight on 15th every 3 months
    ];

    for (const expr of expressions) {
      const job = scheduler.addJob({
        name: `Parse: ${expr}`,
        expression: expr,
        agentId: "a1",
        message: "test",
      });
      expect(job.nextRunAt).toBeDefined();
      expect(new Date(job.nextRunAt!).getTime()).toBeGreaterThan(Date.now());
      scheduler.removeJob(job.id);
    }
    scheduler.stop();
  });
});

describe("parseNaturalLanguageToCron", () => {
  it("should be a function", () => {
    expect(typeof parseNaturalLanguageToCron).toBe("function");
  });
});
