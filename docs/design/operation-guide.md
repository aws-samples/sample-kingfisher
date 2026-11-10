# Operation Guide (summary design · prototype · execution flow · headless acceptance criteria, in one document)

> - Revision: **1.0** (2026-09-06; the direction given, verbatim: "you need to add an operation guide to the web pages, otherwise hardly anyone will know how to use the system as it stands") | delivered as a single construction batch | covered by a dedicated headless-browser acceptance segment
> - Basis: the platform-wide interaction constitution (the [multi-region interaction design](./multi-region-execution-interaction.md), section 0) · the reach surface listed in the feature map (section 0) · the existing `FeatureGuide` (feature-description card) on each page stays untouched; this module is the **global layer** on top of it.

## 1. Summary design

- **Problem**: the platform has many features and heavy terminology (execution environment / jurisdiction / land / fan-out); a new user who opens the home page does not know where to start; the scattered "How it works" cards on each page are collapsed by default and have no cross-page path.
- **Goal**: a ❓ in the top-right corner of every page; opening it gives three things: ① **How to use this page** (purpose / steps / notes / related pages); ② **Getting started** (role-based cross-page paths, each step can jump to its page with one click); ③ a dedicated **Multi-region & compliance** track (the hardest line of this platform to understand). It opens automatically once on the first visit; the user can turn the automatic opening off.
- **Not doing**: no element-by-element highlighted tour (its maintenance cost drifts with the UI); no server-side storage (preferences live only in the browser's localStorage); no change to the existing interaction of any business page.
- **Single author**: all copy lives in `platform/src/lib/guide/content.ts` (`PAGE_GUIDES` / `JOURNEYS` / `MULTI_REGION_FLOW`); steps use only **button / label text that really exists on the page** (character-for-character identical to the `t()` source strings), and every menu leaf is named one by one (gate criterion G-1).

## 2. Prototype (text wireframe)

```
Top bar, right side: [❓ User guide] [Copilot] [Language] [Theme] [Avatar]
                                   │
   ┌──── Drawer 560px ─────────────────────────────────────────────────────────┐
   │ ❓ User guide  [Current page: Batch Compute]                               │
   │ ┌How to use this page┐ Getting started │ Multi-region & compliance        │
   │ Purpose: three kinds of batch jobs… one job can bind several execution    │
   │          regions…                                                         │
   │ Steps:                                                                    │
   │  1. Click "New", choose the job type… fill in the name, then "Create"     │
   │  2. Under "Execution regions (multi-select)" tick regions, or click       │
   │     "Select all active regions"                                           │
   │  3. Write the script… click "Save"                                        │
   │  4. Click "Run now (runs once in each of N regions)"…                     │
   │ Notes: the first operation in a cross-jurisdiction region shows a         │
   │        disclaimer…                                                        │
   │ Related pages: [ETL Orchestration] [Task Monitor] [Execution Environments]│
   ├───────────────────────────────────────────────────────────────────────────┤
   │ ☑ Open the guide automatically after login                                │
   └───────────────────────────────────────────────────────────────────────────┘
   Getting started tab: [Admin (platform go-live) | Data Development | Business analysis] segments → vertical Steps, each step has "Go to this page →"
   Multi-region & compliance tab: 8 vertical Steps (register environment → deploy, probe, enable → authorize workspaces → bind jobs to several regions → multi-region direct query → disclaimer → audit lookback → dashboard fallback)
Home page top: [❓ Onboarding  three steps by role…  (Open the guide) (Go to Projects) (Go to Execution Environments)]
```

## 3. Execution flow

1. `GuideProvider` (mounted in the `app/layoutClient.tsx` shell layer; not mounted on the login page) holds `open / tab`; on the first visit (`localStorage.bgp-guide-seen-v1` does not exist and `bgp-guide-auto !== 0`) it automatically opens "Getting started" and writes seen.
2. The top-bar ❓ (`components/layout/Header.tsx`) calls `openGuide("page")`; the home-page `GuideHomeCard` calls `openGuide("start")`.
3. The drawer `OperationGuideDrawer` takes the current page's guide through `guideForPath()` based on `usePathname()` (exact match > longest prefix; the root matches exactly only); "Go to this page" = close the drawer + `router.push`.
4. The switch at the bottom writes `bgp-guide-auto = 1 | 0`.
5. Copy goes through `t()`: the Chinese source string is the key; the shell strings already have English, the English of the guide body is added as needed (a missing entry falls back to Chinese, consistent with the platform-wide policy).

## 4. Headless acceptance criteria (one dedicated segment, zero ⚠️; unit-test gate `lib/guide/__tests__/content.test.ts`)

| # | Criterion | Source of state |
|---|---|---|
| G-1 | Every menu leaf (routes.tsx) has a "How to use this page" entry, its title is character-for-character identical to the menu label, and it has ≥ 2 steps; the guide mentions no page that does not exist in the menu | Unit test (source parsing) |
| G-2 | The paths of related pages / the three journeys / the dedicated track are all menu leaves ("Go to this page" may never 404) | Unit test |
| G-3 | Copy contains no embedded ASCII double quotes | Unit test |
| G-4 | `guideForPath`: exact match > longest prefix; the root matches exactly only; unknown ⇒ null | Unit test |
| G-5 | A new browser context's first visit opens the guide automatically and lands on "Getting started": three roles, ≥ 4 steps, every step has "Go to this page" | Page DOM |
| G-6 | Switching to the "Data Development" journey: ≥ 4 steps, including "write a batch job and run it in several regions" | Page DOM |
| G-7 | "Go to this page" really navigates to the target page and the drawer closes | URL + DOM |
| G-8 | Already seen ⇒ returning to the home page does not pop the guide up again | localStorage + DOM |
| G-9 | The "Onboarding" card is present on the home page; clicking "Open the guide" ⇒ the drawer opens on "Getting started" | Page DOM |
| G-10 | ❓ on seven pages ⇒ the current-page label == the menu name and ≥ 2 steps; sub-paths match by longest prefix | Page DOM |
| G-11 | The "Multi-region & compliance" track has ≥ 6 steps, including the disclaimer and the audit lookback | Page DOM |
| G-12 | Turning off "Open the guide automatically after login" ⇒ `bgp-guide-auto=0`; a new session does not pop the guide up, ❓ can still open it manually | localStorage + DOM |

## 5. Known limits (recorded honestly)

- The guide body currently exists only in Chinese (the 19 shell strings already have English); the English entries of the multi-region execution UI being missing as a whole is a pre-existing problem, pending a decision on whether to open a work package for it.
- Keeping step copy and page buttons in sync relies on the unit test that "names every leaf" plus manual alignment; it does **not** check at runtime that the buttons exist (that would turn the guide into a second source of acceptance truth).
