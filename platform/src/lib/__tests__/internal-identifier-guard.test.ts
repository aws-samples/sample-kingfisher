// Repository standards guard: no internal tracking identifiers in product code.
//   Product source (platform, infra, scripts, Flink runners) must not carry internal process markers:
//   defect ids, schedule items, design-module numbers, work-package or phase ids, batch tags,
//   construction-step references or acceptance-criteria ids. Rationale and history live in the
//   engineering documents, not in the code that customers deploy and read.
//   Scope is every tracked code file (tests and offline judges included). Two documented exemptions:
//   this file (it spells out the patterns) and the documentation restructuring tool, whose input
//   grammar is the ledger / schedule record key.
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const PLATFORM = process.cwd();
const REPO = path.resolve(PLATFORM, "..");
const TRACKED = execFileSync("git", ["ls-files", "-z"], { cwd: REPO, encoding: "utf8" }).split("\0").filter(Boolean);

const SELF = "platform/src/lib/__tests__/internal-identifier-guard.test.ts";
const PRODUCT = TRACKED.filter(
  (f) =>
    /^(platform\/|infra\/|scripts\/|flink-[^/]+\/)/.test(f) &&
    /\.(ts|tsx|mjs|cjs|js|py|sh|ya?ml|java|xml|json)$/.test(f) &&
    !/core-dist\//.test(f) && // generated copies of platform sources; the manifest guard keeps them in sync
    f !== SELF &&
    // The documentation restructuring tool parses ledger and schedule records; the record keys are its input grammar.
    f !== "scripts/lib/docs_restructure.py",
);

// One alternation per identifier family. Word boundaries keep ordinary text such as "B-tree" or "P50" intact.
const INTERNAL_ID = new RegExp(
  [
    String.raw`(?<![A-Za-z0-9_-])B-\d{1,3}[a-z]?(?![A-Za-z0-9_-])`, // defect ledger entries
    String.raw`(?<![A-Za-z0-9_顺工施次程])序 ?\d{1,3}(?![\d])`, // schedule items
    String.raw`(?<![A-Za-z0-9_子])模块 ?\d{1,3}(?![\d])`, // design module numbers
    String.raw`(?<![A-Za-z0-9_-])WP-\d+[a-z]*(?![A-Za-z0-9_-])`, // work packages
    String.raw`(?<![A-Za-z0-9_.])P\d{2}\.\d+[a-z]?(?![A-Za-z0-9_.])`, // phase ids
    String.raw`@kf-batch`, // batch tags
    String.raw`施工序`, // construction steps
    String.raw`WORK-PACKAGES(?!\.md)`, // prose references to the internal work-package document (a doc-drift test may read the file itself)
    String.raw`(?<![A-Za-z0-9_-])E-\d{2,3}(?![A-Za-z0-9_-])`, // acceptance-criteria ids
    String.raw`(?<![A-Za-z0-9_-])T-\d{1,2}(?![A-Za-z0-9_-])`, // ticket ids
    String.raw`(?<![A-Za-z0-9_-])SC-\d+(?![A-Za-z0-9_-])`, // scope work tickets (formerly rendered in the UI)
    String.raw`(?<![A-Za-z0-9_-])S-\d{1,2}(?![A-Za-z0-9_-])`, // spike ids
  ].join("|"),
  "u",
);

describe("repository standards: product code carries no internal tracking identifiers", () => {
  it("scans every tracked product source file", () => {
    expect(PRODUCT.length).toBeGreaterThan(1500);
  });

  it("finds no internal identifier in product source", () => {
    const hits: string[] = [];
    for (const f of PRODUCT) {
      const lines = fs.readFileSync(path.join(REPO, f), "utf8").split("\n");
      lines.forEach((line, i) => {
        if (INTERNAL_ID.test(line)) hits.push(`${f}:${i + 1}: ${line.trim().slice(0, 120)}`);
      });
    }
    expect(hits, "internal identifiers found in product source").toEqual([]);
  });
});
