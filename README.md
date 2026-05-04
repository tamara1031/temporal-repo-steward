# temporal-repo-steward

A pull-based, webhook-free, Temporal-driven autonomous AI agent platform.  
It periodically scans a repository, opens refactor PRs via codex, self-heals CI failures, and merges automatically.

```
Temporal Schedule ──▶ periodicRefactorWorkflow
                          ├─▶ refactorStepWorkflow (child, ×N steps)  — implement → review loop
                          └─▶ robustPRMergeWorkflow (child)            — push → CI → merge
```

## Features

- **Periodic refactor**: Schedule triggers → codex analyses and applies changes → PR → CI self-heal → auto-merge.
- **CI self-heal loop**: Feeds `gh run view --log-failed` output to codex → fix → push → wait for CI again.
- **Conflict resolution loop**: Trial merge with `git merge --no-commit` → codex resolves conflicts → push → back to CI.
- **External-interference tolerant**: If a PR is closed or merged externally during CI polling, the workflow exits cleanly instead of throwing.
- **Advisor (upper-model consult)**: On the second self-heal iteration or on no-diff, queries `ADVISOR_MODEL` for `{verdict: retry|abort|change-strategy}`. Aborts early on `abort`. Input is a pre-aggregated summary (≤ 2 KiB) to keep token usage minimal. Hard-capped at `maxAdvisorConsults` (default 1 for periodic, 2 for PR lifecycle). Falls back to the codex default model when `ADVISOR_MODEL` is unset.
- **Post-merge polling**: Distinguishes `gh pr merge --auto` acceptance from actual merge landing. Polls until `mergedAt` is observed; returns `merge-queued` if the protection gate hasn't cleared yet.

> Issue-driven routes and direct Claude API integration are currently removed.  
> To re-add them, reuse `refactorStepWorkflow` (implement → review loop) and  
> `robustPRMergeWorkflow` (push → CI → merge) as child workflows.

## Directory structure

```
.
├── Dockerfile                       # Node 20 + gh CLI + codex CLI
├── docker-compose.yml               # Local dev: Temporal dev server + worker
├── deploy/k8s/worker-deployment.yaml# Kubernetes Deployment manifest
├── package.json                     # @temporalio/* (~1.11)
├── tsconfig.json
├── .env.example                     # Worker env var template
├── scripts/
│   ├── schedule-setup.sh            # temporal schedule create --upsert
│   └── build-workflow-bundle.ts     # Pre-bundle for production
├── src/
│   ├── constants.ts                 # TASK_QUEUE
│   ├── worker.ts                    # Worker entry point; spawns codex app-server in-process
│   ├── client.ts                    # Dev client (install-schedule / run-once)
│   ├── activities/                  # Activities registered with the worker (1 file = 1 Activity)
│   │   ├── index.ts                 # Barrel — registered with Worker
│   │   ├── _internal/               # Shared helpers (not Activities)
│   │   ├── advisor/                 # Upper-model consult (consultAdvisorActivity)
│   │   ├── codex/                   # Generic single-shot codex (codexActivity)
│   │   ├── git/                     # clone / commit / push / conflict / restore / etc.
│   │   ├── github/                  # gh CLI (create-pr / wait-for-ci / merge / observe)
│   │   └── refactor/                # Role-specific codex (extract-context / plan / implement / review)
│   └── workflows/                   # Workflow definitions (deterministic)
│       ├── index.ts
│       ├── proxies.ts               # proxyActivities groups (cheap / heavy / *Codex / advisor / ciWait)
│       ├── periodic.ts              # periodicRefactorWorkflow (orchestrator)
│       ├── refactor-step.ts         # refactorStepWorkflow (child, 1 plan step)
│       ├── pr-lifecycle.ts          # robustPRMergeWorkflow (child)
│       └── _internal/               # Workflow helpers (non-workflow code)
│           ├── advisor.ts           # Advisor budget + consult protocol
│           ├── porcelain.ts         # git status/diff helpers
│           ├── refactor-report.ts   # PR body renderer (pure)
│           ├── refactor-step-loop.ts# implement → Parliament loop body
│           └── spawn-budget.ts      # codex spawn counter + cap
├── tests/
│   ├── exec.test.ts
│   ├── git.test.ts
│   ├── github.test.ts
│   ├── github-ci.test.ts
│   ├── porcelain.test.ts
│   ├── periodic.test.ts             # periodicRefactorWorkflow (TestWorkflowEnvironment)
│   ├── pr-lifecycle.test.ts         # robustPRMergeWorkflow (TestWorkflowEnvironment)
│   ├── replay.test.ts               # History-replay compatibility (placeholder)
│   ├── helpers.ts                   # Bundle + mock activity factory
│   └── fixtures/replay/             # Replay history fixture directory
└── docs/
    ├── architecture.md              # Workflow/Activity design, configuration reference
    └── deployment-example.md        # Kubernetes deployment example
```

See [`docs/architecture.md`](./docs/architecture.md) for the full Activity/Workflow input and environment variable reference.

## Quick start (local)

```bash
# 1. Start a Temporal dev server in a separate terminal
temporal server start-dev

# 2. Install dependencies
npm install

# 3. Log in to codex via browser (~/.codex/auth.json is created)
codex login

# 4. Configure env and start the worker
cp .env.example .env
$EDITOR .env        # set GITHUB_TOKEN, GIT_BOT_NAME, GIT_BOT_EMAIL
npm run start.worker.dev

# 5. Install the schedule
npm run start.client -- --command=install-schedule --repo=<owner>/<repo>

# 6. Run tests (TestWorkflowEnvironment starts a local Temporal server)
npm test
```

See [`docs/architecture.md`](./docs/architecture.md) and [`docs/deployment-example.md`](./docs/deployment-example.md) for more detail.

## Authentication

| Credential | Format | Purpose |
| --- | --- | --- |
| `GITHUB_TOKEN` | env var | `gh` CLI and `git push` |
| `~/.codex/auth.json` | JSON file | codex CLI (created by `codex login`) |

`OPENAI_API_KEY` is **not** used. The worker uses codex's browser-login `auth.json`.  
Set `CODEX_HOME` to override the directory where `auth.json` is read.

### GitHub PAT permissions

The PAT must have the following permissions on the **target repository**:

#### Fine-grained PAT (recommended — scoped to a single repo)

| Permission | Level | Purpose |
| --- | --- | --- |
| `Contents` | Read & Write | clone / branch / push |
| `Pull requests` | Read & Write | create PR / merge |
| `Actions` | Read | `gh run view --log-failed` (CI failure logs) |
| `Workflows` | Read & Write | Required when the refactor touches `.github/workflows/*.yml` |
| `Metadata` | Read | Granted automatically on all fine-grained PATs |

> Without `Workflows`, a push that modifies workflow files will be rejected by GitHub.

#### Classic PAT (simpler — applies to the entire owner)

Minimum scopes:
- `repo` (covers Contents / PRs / Actions / Workflows)
- `workflow` (required when `.github/workflows` files are modified)

#### Token expiry

Set a short expiry (e.g. 90 days) and have a rotation plan.  
An expired token causes `gh`/`git` 401 errors that exhaust Activity retries before the Workflow fails.  
Check the Temporal Web UI (`:8233`) for `401 Unauthorized` in the failure history.

For Kubernetes deployments, store credentials as Secrets. See [`docs/deployment-example.md`](./docs/deployment-example.md).

## Design decisions

- **Pull-based**: No inbound endpoint. Everything is triggered by a Temporal Schedule. No Service, Ingress, or HTTPRoute required.
- **CI wait is a heartbeating Activity**: Multi-minute waits use Activity-side polling with heartbeat rather than `workflow.sleep()`.
- **PR lifecycle is a Child Workflow**: Reusable by any orchestrator (e.g. an issue-driven workflow can call the same child).
- **Tiered Activity retry policies**: lightweight (gh reads) / heavyweight (clone, push) / per-codex-role / advisor / CI-wait each have independent retry/timeout settings. `MissingCredentials`, `InvalidGitRef`, `PlannerOutputInvalid`, `AdvisorOutputInvalid`, and `InvalidGitHubOutput` are **nonRetryable** — they fail immediately. See the [Activity proxy table](./docs/architecture.md#activity-proxy-mapping).
- **Determinism**: Workflows never call `Date.now()`, `Math.random()`, `process.env`, or `fs` directly — all side effects are pushed into Activities.
- **codex sandbox**: All codex invocations use `dangerFullAccess` (app-server: `sandboxPolicy: { type: 'dangerFullAccess' }`; subprocess fallback: `--sandbox danger-full-access`). The Pod itself is the isolation boundary — it runs non-root with restricted egress. codex's own sandbox modes (`workspace-write`, `read-only`) require bubblewrap / unprivileged user-namespace support that we do not want to coordinate with the cluster operator.

## CI and branch protection

`.github/workflows/ci.yml` has two jobs:

| Job | Content | On PR | On push to main |
| --- | --- | --- | --- |
| `build / lint / test` | npm build + lint + test | ✅ | ✅ |
| `docker image` | Dockerfile build + push to GHCR | build only | pushes `ghcr.io/<owner>/<repo>:preview` |

The `:preview` tag tracks the latest main commit. Stable releases use `:0.x.y` and `:latest` pushed by a `workflow_dispatch` Release workflow (git tag convention: `v0.x.y`).

### Branch protection (required)

**Without branch protection, `gh pr merge --auto` will merge even when CI is red.**

1. `Settings → Branches → Branch protection rules → Add rule`
2. Branch name pattern: `main`
3. ✅ Require a pull request before merging
4. ✅ Require status checks to pass before merging  
   — check "Require branches to be up to date before merging"  
   — add `build / lint / test` and `docker image` as required checks
5. ✅ Do not allow bypassing the above settings (optional, stricter)

### GHCR package visibility

The `ghcr.io/<owner>/<repo>` package is created as private on the first push.  
To make it public, change visibility in GitHub Packages settings and link it to the repository.

`mergePRActivity` uses `--auto --squash --delete-branch`, so the agent merges automatically when CI turns green.  
Pass `autoMerge: false` as workflow input to stop just before merge (returns `outcome: 'auto-merge-disabled'`).

## Known limitations

- **workdir is pod-local**: The parent Workflow's `workdir` is reused by child Workflows on the assumption they run on the same Worker pod. When scaling, either pin a Workflow to a pod, use a shared volume for `workdir`, or re-clone in each child.
- **codex CLI flags are version-sensitive**: Arguments are based on the documented API at build time. Pin the version in CI; absorb breaking changes in `src/activities/_internal/run-codex.ts` and `run-codex-app-server.ts`.
- **Replay fixtures not set up**: `tests/fixtures/replay/` is a placeholder. Adding `Worker.runReplayHistory` tests to CI would make versioning long-lived Workflows (especially `pr-lifecycle.ts`) safe.
- **`change-strategy` verdict is treated as `retry`**: The advisor can return `change-strategy` but the current implementation handles it identically to `retry` (the suggestion is recorded in the audit log only). A future branch could implement concrete actions like converting the PR to a draft.
