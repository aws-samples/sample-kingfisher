// Repository standards guard (see docs/development.md, section 14).
//   1. Documentation is English: tracked Markdown contains no CJK characters.
//   2. Every relative link in tracked Markdown resolves to a tracked path.
//   3. Figures are PNG or WebP only; every figure is referenced from a tracked text file;
//      every Mermaid source has a rendered PNG; docs/diagrams/README.md lists every figure in that folder.
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const PLATFORM = process.cwd();
const REPO = path.resolve(PLATFORM, "..");
const TRACKED = execFileSync("git", ["ls-files", "-z"], { cwd: REPO, encoding: "utf8" }).split("\0").filter(Boolean);
const TRACKED_SET = new Set(TRACKED);
const MARKDOWN = TRACKED.filter((f) => f.endsWith(".md"));
const TEXT = TRACKED.filter((f) => /\.(md|tsx?|mjs|cjs|js|py|sh|ya?ml|json|html|mmd|txt|toml)$/.test(f));
const IMAGES = TRACKED.filter((f) => /\.(png|webp|jpe?g|gif|svg|bmp|tiff?)$/i.test(f));
const read = (f: string) => fs.readFileSync(path.join(REPO, f), "utf8");

const CJK = /[　-〿぀-ヿ㐀-䶿一-鿿豈-﫿＀-￯]/;
const LINK = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)|<img[^>]+src="([^"]+)"/g;

/** Markdown with fenced code blocks and inline code spans removed, so that code is never read as a link. */
function prose(markdown: string): string {
  return markdown.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
}

function trackedPathExists(p: string): boolean {
  if (TRACKED_SET.has(p)) return true;
  const prefix = p.endsWith("/") ? p : `${p}/`;
  return TRACKED.some((f) => f.startsWith(prefix));
}

describe("repository standards", () => {
  it("tracked Markdown is English", () => {
    const offenders = MARKDOWN.filter((f) => CJK.test(read(f)));
    expect(offenders, "Markdown files containing CJK characters").toEqual([]);
  });

  it("every relative link in Markdown resolves to a tracked path", () => {
    const dead: string[] = [];
    for (const f of MARKDOWN) {
      const text = prose(read(f));
      for (const m of text.matchAll(LINK)) {
        const raw = (m[1] ?? m[2] ?? "").split("#")[0];
        if (!raw || /^(https?:|mailto:)/.test(raw)) continue;
        const target = path.posix.normalize(path.posix.join(path.posix.dirname(f), raw));
        if (!trackedPathExists(target)) dead.push(`${f} -> ${raw}`);
      }
    }
    expect(dead).toEqual([]);
  });

  it("figures are PNG or WebP only", () => {
    const other = IMAGES.filter((f) => !/\.(png|webp)$/i.test(f));
    expect(other).toEqual([]);
  });

  it("every figure is referenced from a tracked text file", () => {
    const corpus = TEXT.map(read).join("\n");
    const orphans = IMAGES.filter((f) => !corpus.includes(path.posix.basename(f)));
    expect(orphans).toEqual([]);
  });

  it("every Mermaid source has a rendered PNG and the diagrams index lists every figure", () => {
    const sources = TRACKED.filter((f) => /^docs\/diagrams\/src\/[^/]+\.mmd$/.test(f));
    const unrendered = sources.filter((s) => !TRACKED_SET.has(`docs/diagrams/${path.posix.basename(s, ".mmd")}.png`));
    expect(unrendered).toEqual([]);
    const index = read("docs/diagrams/README.md");
    const figures = TRACKED.filter((f) => /^docs\/diagrams\/[^/]+\.png$/.test(f));
    const unlisted = figures.filter((f) => !index.includes(path.posix.basename(f)));
    expect(unlisted).toEqual([]);
  });
});
