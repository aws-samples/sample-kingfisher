// Guard for the local development template `platform/.env.example`.
//   1. The key list equals the platform container environment defined in `infra/lib/platform-stack.ts`,
//      in the same order, with nothing missing and nothing extra.
//   2. Every entry is a bare key with an empty value. A real value in the template is a red-line incident.
//   3. The header tells the reader where the live values come from and to copy the file to the ignored `.env.local`.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const PLATFORM = process.cwd();
const REPO = path.resolve(PLATFORM, "..");
const STACK = path.join(REPO, "infra", "lib", "platform-stack.ts");
const TEMPLATE = path.join(PLATFORM, ".env.example");

function containerEnvKeys(): string[] {
  const lines = fs.readFileSync(STACK, "utf8").split("\n");
  const start = lines.findIndex((l) => l.includes('addPropertyOverride("ContainerDefinitions.0.Environment"'));
  expect(start, "container environment override not found in platform-stack.ts").toBeGreaterThan(0);
  const keys: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*\]\);\s*$/.test(line)) return keys;
    const m = /^\s+([A-Z][A-Z0-9_]*):\s/.exec(line);
    if (m) keys.push(m[1]);
  }
  throw new Error("container environment override is not closed");
}

describe("platform/.env.example mirrors the platform container environment", () => {
  const lines = fs.readFileSync(TEMPLATE, "utf8").split("\n");
  const entries = lines.filter((l) => l && !l.startsWith("#"));

  it("lists exactly the container variables, in the same order", () => {
    const templateKeys = entries.map((l) => l.split("=")[0]);
    const stackKeys = containerEnvKeys();
    expect(stackKeys.length).toBeGreaterThan(50);
    expect(templateKeys).toEqual(stackKeys);
  });

  it("contains keys only; every value is empty", () => {
    for (const line of entries) {
      expect(line, `template line carries a value: ${line}`).toMatch(/^[A-Z][A-Z0-9_]*=$/);
    }
  });

  it("explains where live values come from and where to put them", () => {
    const head = lines.filter((l) => l.startsWith("#")).join("\n");
    expect(head).toContain("describe-task-definition");
    expect(head).toContain(".env.local");
  });
});
