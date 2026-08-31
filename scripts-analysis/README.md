# Manifest Analyzer v1.0

A **read-only** developer toolkit that produces a full health, architecture and
documentation report for the Pulse ERP ("Manifest") monorepo.

> **It never modifies application source.** It only reads code, `package.json`,
> and config files, and writes reports into `analysis/`. It does not edit, rename
> or delete files, auto-fix code, update dependencies, change imports, run git, or
> connect to any cloud service. Everything runs offline on Windows.

## Usage

```bash
npm run analyze
```

That single command runs every step and writes everything under `analysis/`.
Re-running is safe and idempotent — it overwrites only analysis outputs.

When it finishes, open the dashboard:

```
analysis/index.html
```

Partial runs (each still writes only under `analysis/`):

```bash
npm run analyze:frontend   # madge + dependency-cruiser + knip + eslint + route report
npm run analyze:backend    # madge + dependency-cruiser + npm audit + api report
```

## What it produces

```
analysis/
├── index.html                     # interactive dashboard (step 18)
├── manifest.json                  # run manifest + step outcomes
├── graphs/
│   ├── frontend.svg / backend.svg # madge graphs (needs Graphviz `dot`)
│   ├── frontend-architecture.md   # Mermaid diagrams (step 8)
│   ├── backend-architecture.md
│   ├── module-dependency-graph.md
│   ├── api-flow.md
│   └── folder-structure.md
├── reports/
│   ├── madge-frontend.txt / madge-backend.txt      (step 1)
│   ├── dependency-report.html / .json              (step 2)
│   ├── dependency-report-backend.html / .json
│   ├── knip-report.txt / .json                     (step 3)
│   ├── eslint-report.txt                           (step 4, report only)
│   ├── audit-report.txt                            (step 5, report only)
│   ├── project-health.md                           (step 10)
│   ├── dependency-heatmap.md                        (step 12)
│   ├── dead-code-report.md                          (step 13)
│   ├── duplicate-report.md                          (step 14)
│   ├── todo-report.md                               (step 15)
│   ├── route-report.md                              (step 16)
│   └── api-report.md                                (step 17)
├── documentation/                 # Architecture, Frontend, Backend, Modules,
│                                   # FolderStructure, CodingPatterns, Services,
│                                   # APIs, Dashboard (step 9)
├── statistics/                    # project-statistics.json, module-statistics.json,
│                                   # api-endpoints.json, dependency-heatmap.json,
│                                   # dead-code.json, duplicates.json, todos.json, health.json
├── summary/
│   └── ai-summary.md              # summary written for an AI assistant (step 11)
└── logs/
    └── analyze-run.log            # per-step timing + status
```

## How it works

- `scripts/analyze.js` — orchestrator. Runs frontend analysis, backend analysis,
  then synthesis, and writes the run manifest.
- `scripts/frontend-analysis.js` — steps 1–4 (frontend) + route report.
- `scripts/backend-analysis.js` — steps 1–2 (backend) + npm audit + API report.
- `scripts/generate-summary.js` — steps 6–15 & 18 synthesis.
- `scripts/lib/` — shared library:
  - `config.js` paths, tool locations, module detection.
  - `fsx.js` **write guard** — every write is asserted to land inside `analysis/`.
  - `exec.js` process runner (shell-free `node <tool>`) + step logger.
  - `scan.js` source scanning, API/route parsing, import graph.
  - `statistics.js`, `quality.js`, `diagrams.js`, `health.js`, `docs.js`, `dashboard.js`.

### Design notes / guarantees

- **Read-only by construction.** All writes go through `fsx.write()`, which throws
  if the target resolves outside `analysis/`. The application is never imported
  (importing the backend would open DB connections and start cron jobs) — only
  read as text.
- **Degrades gracefully.** A missing or failing tool is recorded and skipped; you
  still get a partial report. The SVG graphs need Graphviz `dot`; without it a
  `.SKIPPED.txt` note is written and the Mermaid diagrams remain available.
- **Offline.** `npm audit` needs the registry advisory DB; when offline it is
  reported as unavailable and the Security score is excluded from the average.
- **Heuristic, and honest about it.** Route/API/dead-code detection is static
  regex/graph analysis tuned to this repo's conventions. Each report documents its
  blind spots (dynamic imports, migrations, gates applied at mount time, …). Treat
  findings as candidates for a human to verify — nothing is auto-actioned.

## Requirements

- Node.js ≥ 18 (tested on v24).
- Tools are already installed in the repo: `madge` (workspace root),
  `dependency-cruiser`, `knip`, `eslint` (in `Pulse/frontend`).
- Optional: [Graphviz](https://graphviz.org/) on `PATH` for the madge SVG graphs.

## Extending (v2, v3, …)

Add a new report as a module under `scripts/lib/` that takes the scan context and
calls `fsx.write()` for its output, then invoke it from `generate-summary.js`. The
scan (`collectSources`, `buildApiSurface`, `buildRouteMap`, `importGraph`) is done
once and shared, so new reports are cheap to add.
