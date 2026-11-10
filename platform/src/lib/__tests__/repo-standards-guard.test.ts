// Repository standards guard (see docs/development.md, section 14).
//   1. Documentation is English: tracked Markdown prose contains no CJK characters. Fenced code blocks are
//      excerpts of real source (whose comments and string literals are Chinese by convention, see README
//      "Languages") and are shown verbatim, so they are excluded; inline code spans in prose are still checked.
//   2. Every relative link in tracked Markdown resolves to a tracked path, and a `#fragment` on a link to a
//      Markdown file resolves to a heading (GitHub slug) or an explicit HTML id in that file.
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

/** Markdown with fenced code blocks removed: verbatim source excerpts may carry Chinese comments and literals. */
function withoutFencedCode(markdown: string): string {
  return markdown.replace(/```[\s\S]*?```/g, "");
}

/** GitHub's heading-to-anchor rule: strip inline markup, lower-case, drop punctuation, spaces to hyphens, number repeats. */
function headingSlug(text: string): string {
  const plain = text
    .replace(/<[^>]+>/g, "")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\*\*|\*|__|~~/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .trim()
    .toLowerCase();
  return Array.from(plain).filter(keptInAnchor).join("").replace(/ /g, "-");
}

/** Characters GitHub keeps in an anchor: ASCII letters and digits, space, hyphen, underscore, and letters of the scripts this repository writes in
 *  (Latin-1 / Latin Extended, Greek, Cyrillic, Hiragana / Katakana, CJK ideographs, Hangul). Spelled out as code-point ranges because the
 *  platform compiles with `target: es5`, which rejects the `u` regex flag that `\p{L}` would need. */
function keptInAnchor(ch: string): boolean {
  if (/[A-Za-z0-9 _-]/.test(ch)) return true;
  const c = ch.codePointAt(0) ?? 0;
  return (
    (c >= 0x00c0 && c <= 0x024f && c !== 0x00d7 && c !== 0x00f7) ||
    (c >= 0x0370 && c <= 0x052f) ||
    (c >= 0x3040 && c <= 0x30ff) ||
    (c >= 0x3400 && c <= 0x4dbf) ||
    (c >= 0x4e00 && c <= 0x9fff) ||
    (c >= 0xac00 && c <= 0xd7af) ||
    (c >= 0xf900 && c <= 0xfaff)
  );
}

/** Every anchor a Markdown file exposes on GitHub: heading slugs (with -1, -2 suffixes for repeats) plus explicit id/name attributes. */
function anchorsOf(markdown: string): Set<string> {
  const anchors = new Set<string>();
  for (const m of markdown.matchAll(/(?:id|name)="([^"]+)"/g)) anchors.add(m[1]);
  const seen = new Map<string, number>();
  for (const line of markdown.replace(/```[\s\S]*?```/g, "").split("\n")) {
    const h = /^ {0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (!h) continue;
    const slug = headingSlug(h[1]);
    const n = seen.get(slug) ?? 0;
    seen.set(slug, n + 1);
    anchors.add(n === 0 ? slug : `${slug}-${n}`);
  }
  return anchors;
}

function trackedPathExists(p: string): boolean {
  if (TRACKED_SET.has(p)) return true;
  const prefix = p.endsWith("/") ? p : `${p}/`;
  return TRACKED.some((f) => f.startsWith(prefix));
}

describe("repository standards", () => {
  it("tracked Markdown prose is English (fenced code excerpts are verbatim and exempt)", () => {
    const offenders = MARKDOWN.filter((f) => CJK.test(withoutFencedCode(read(f))));
    expect(offenders, "Markdown files containing CJK characters outside fenced code").toEqual([]);
  });

  it("withoutFencedCode keeps prose and inline code, drops fenced blocks only", () => {
    expect(withoutFencedCode("a `b` c\n```ts\nconst x = 1;\n```\nd")).toBe("a `b` c\n\nd");
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

  it("every #fragment on a link to a tracked Markdown file names a heading or an explicit id in that file", () => {
    const anchorCache = new Map<string, Set<string>>();
    const dangling: string[] = [];
    for (const f of MARKDOWN) {
      const text = prose(read(f));
      for (const m of text.matchAll(LINK)) {
        const href = m[1] ?? "";
        if (!href.includes("#") || /^(https?:|mailto:)/.test(href)) continue;
        const [rawPath, fragment] = href.split("#", 2);
        if (!fragment) continue;
        const target = rawPath ? path.posix.normalize(path.posix.join(path.posix.dirname(f), rawPath)) : f;
        if (!target.endsWith(".md") || !TRACKED_SET.has(target)) continue;
        let anchors = anchorCache.get(target);
        if (!anchors) {
          anchors = anchorsOf(read(target));
          anchorCache.set(target, anchors);
        }
        const wanted = decodeURIComponent(fragment);
        if (!anchors.has(wanted) && !anchors.has(wanted.toLowerCase())) dangling.push(`${f} -> ${href}`);
      }
    }
    expect(dangling).toEqual([]);
  });

  it("headingSlug follows GitHub's anchor rule", () => {
    expect(headingSlug("7ter. Upgrading (bringing a new version live)")).toBe("7ter-upgrading-bringing-a-new-version-live");
    expect(headingSlug("7bis. Retiring an execution region (deleting an execution environment)")).toBe("7bis-retiring-an-execution-region-deleting-an-execution-environment");
    expect(headingSlug("`scripts/foo.sh` — **bold** and [link](x.md)")).toBe("scriptsfoosh--bold-and-link");
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
