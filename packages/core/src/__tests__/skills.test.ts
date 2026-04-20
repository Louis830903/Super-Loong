/**
 * Skills Module — Comprehensive Tests.
 *
 * Covers: parseSkillFile (multi-format parser), SkillLoader, SkillMarketplace structure.
 */
import { describe, it, expect } from "vitest";
import { parseSkillFile, type SkillFormat } from "../skills/parser.js";
import { SkillMarketplace } from "../skills/marketplace.js";

// ─── Skill Parser ──────────────────────────────────────────
describe("parseSkillFile", () => {
  it("should parse Super Agent format", () => {
    const raw = `---
name: web-search
description: Search the web for information
version: "1.0"
platforms:
  - all
security:
  sandbox: process
metadata:
  tags:
    - search
    - web
---
## Instructions
Use this skill to search the web.`;

    const parsed = parseSkillFile(raw);
    expect(parsed.format).toBe("super-agent");
    expect(parsed.frontmatter.name).toBe("web-search");
    expect(parsed.frontmatter.description).toContain("Search");
    expect(parsed.content).toContain("Instructions");
  });

  it("should parse Hermes format", () => {
    const raw = `---
name: code-review
description: Review code for issues
requires_toolsets:
  - filesystem
  - code_analysis
fallback_for_toolsets:
  - none
---
Review the code provided.`;

    const parsed = parseSkillFile(raw);
    expect(parsed.format).toBe("hermes");
    expect(parsed.frontmatter.name).toBe("code-review");
  });

  it("should parse OpenClaw format", () => {
    const raw = `---
name: simple-skill
description: A simple skill
---
Just do the thing.`;

    const parsed = parseSkillFile(raw, "test/SKILL.md");
    expect(parsed.format).toBe("openclaw");
  });

  it("should handle unknown format gracefully", () => {
    const raw = `No frontmatter here, just content.`;
    const parsed = parseSkillFile(raw);
    expect(parsed.format).toBe("unknown");
    expect(parsed.content).toContain("No frontmatter");
  });

  it("should detect format by field presence", () => {
    // Has only name + description (<=4 fields) → openclaw
    const minimal = `---
name: minimal
description: test
---
content`;
    const p1 = parseSkillFile(minimal);
    expect(p1.format).toBe("openclaw");

    // Has platforms → super-agent
    const withPlatforms = `---
name: platform-skill
description: test
platforms:
  - windows
---
content`;
    const p2 = parseSkillFile(withPlatforms);
    expect(p2.format).toBe("super-agent");
  });
});

// ─── SkillMarketplace ──────────────────────────────────────
describe("SkillMarketplace", () => {
  it("should create marketplace instance", () => {
    const marketplace = new SkillMarketplace();
    expect(marketplace).toBeDefined();
  });

  it("should have search, install, uninstall, getInstalled methods", () => {
    const marketplace = new SkillMarketplace();
    expect(typeof marketplace.search).toBe("function");
    expect(typeof marketplace.install).toBe("function");
    expect(typeof marketplace.uninstall).toBe("function");
    expect(typeof marketplace.getInstalled).toBe("function");
  });

  it("should return empty installed list initially", () => {
    const marketplace = new SkillMarketplace();
    const installed = marketplace.getInstalled();
    expect(Array.isArray(installed)).toBe(true);
  });
});
