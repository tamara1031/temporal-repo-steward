# アーキテクチャ

## 全体構成

```mermaid
flowchart LR
    Schedule["Temporal Schedule<br/>(cron)"] -->|start| Periodic[periodicRefactorWorkflow]
    Periodic -->|executeChild| Robust[robustPRMergeWorkflow]

    subgraph Worker["Worker Pod"]
        direction TB
        Periodic
        Robust
        Activities["Activities<br/>(git / github / codex / refactor)"]
    end

    Periodic -.->|"poll<br/>task queue"| Activities
    Robust -.->|"poll<br/>task queue"| Activities

    Activities -->|gh CLI / git / codex| External[(GitHub<br/>+ codex API)]
```

> 現在の実装は定期リファクタリング 1 本に絞っており、コード生成側は codex のみ。
> Issue 駆動ルートや別 LLM (claude など) を後で追加したくなったら、`robustPRMergeWorkflow`
> をリユーザブルな子ワークフローとしてそのまま再利用できる。

---

## Activity ディレクトリ構成

`src/activities/` は **「1 ファイル = 1 Activity」** が原則。複数 Activity に共有される
非 Activity ヘルパーはクラスタ直下の `_internal/` に閉じ込め、`activities/index.ts`
バレルからは再 export しない。クラスタは関心の塊で分け、必要に応じてさらに
ネストする。

```
src/activities/
├── index.ts                       # Worker が登録する Activity の barrel
├── _internal/                     # クラスタ横断の共有ヘルパー (非 Activity)
│   ├── exec.ts                    # 子プロセス起動 (heartbeat + cancellation)
│   └── run-codex.ts               # `codex exec` ラッパ + 429 検知
│
├── codex/                         # 汎用シングルショット codex
│   ├── index.ts
│   └── codex.ts                   # codexActivity (CI 自己修復・コンフリクト解消用)
│
├── git/                           # ワークスペース + git plumbing
│   ├── index.ts
│   ├── _internal/
│   │   └── git-env.ts             # ghAuthEnv / ref ヘルパー
│   ├── clone.ts                   # cloneRepoActivity
│   ├── commit.ts                  # commitAllActivity
│   ├── push.ts                    # pushBranchActivity
│   ├── check-conflict.ts          # checkConflictActivity
│   ├── cleanup.ts                 # cleanupWorkspaceActivity
│   ├── diff-stat.ts               # diffStatActivity (Pre-Parliament gate)
│   ├── diff-text.ts               # diffTextActivity (reviewer 入力)
│   ├── status-porcelain.ts        # statusPorcelainActivity (drift baseline)
│   └── restore.ts                 # restoreActivity (rollback / drift revert)
│
├── github/                        # gh CLI 経由
│   ├── index.ts
│   ├── _internal/
│   │   ├── gh-env.ts              # ghEnv + sleepCancellable
│   │   ├── gh-json.ts             # JSON エラー型
│   │   ├── ci-rollup.ts           # statusCheckRollup の解釈
│   │   └── pr-view.ts             # gh pr view の戻り値パース
│   ├── create-pr.ts               # createPRActivity
│   ├── wait-for-ci.ts             # waitForCIActivity
│   ├── fetch-failed-logs.ts       # fetchFailedRunLogsActivity
│   └── merge-pr.ts                # mergePRActivity
│
└── refactor/                      # codex の役割別 Activity
    ├── index.ts
    ├── _internal/
    │   ├── types.ts               # ContextArtifact / PlanStep / etc.
    │   ├── prompts.ts             # 役割別プロンプト (静的先頭 / 動的末尾)
    │   └── parsers.ts             # JSON パーサ (extract / plan / review)
    ├── extract-context.ts         # extractContextArtifactActivity
    ├── plan.ts                    # planActivity
    ├── implement.ts               # implementActivity
    └── review.ts                  # reviewActivity
```

### クラスタの依存関係

```mermaid
flowchart TB
    subgraph shared["_internal (cluster-wide)"]
        Exec[exec.ts<br/>execCommand / execOrThrow]
        RunCodex[run-codex.ts<br/>runCodexExec + 429 detector]
    end

    subgraph codex_cluster["codex/"]
        CodexAct[codexActivity]
    end

    subgraph git_cluster["git/"]
        GitEnv["_internal/git-env"]
        GitActs["clone / commit / push / check-conflict /<br/>cleanup / diff-stat / diff-text /<br/>status-porcelain / restore"]
    end

    subgraph github_cluster["github/"]
        GhInternals["_internal<br/>(gh-env / gh-json /<br/>ci-rollup / pr-view)"]
        GhActs["create-pr / wait-for-ci /<br/>fetch-failed-logs / merge-pr"]
    end

    subgraph refactor_cluster["refactor/"]
        RefInternals["_internal<br/>(types / prompts / parsers)"]
        RefActs["extract-context / plan /<br/>implement / review"]
    end

    GitActs --> GitEnv
    GitActs --> Exec
    GhActs --> GhInternals
    GhActs --> Exec
    RefActs --> RefInternals
    RefActs --> RunCodex
    CodexAct --> RunCodex
    CodexAct --> Exec
    RunCodex --> Exec
    GitEnv --> Exec
```

`_internal/` の中身は同じクラスタ内のみで使う。クロスクラスタ参照は
`activities/_internal/` に置いた共有 (`exec` / `run-codex`) のみ許す。

---

## Workflow の責務

### `periodicRefactorWorkflow`

```mermaid
flowchart TD
    Start([start]) --> Clone[cloneRepoActivity<br/>heavy]
    Clone --> Ctx[extractContextArtifactActivity<br/>contextCodex]
    Ctx --> Plan[planActivity<br/>planCodex]
    Plan --> NoOp{theme == 'no-op'<br/>or steps == ∅?}
    NoOp -->|yes| RetNoOp([return<br/>skipped: 'no-op-plan']):::ret
    NoOp -->|no| Cap[steps = plan.steps<br/>.slice 0, MAX_STEPS=2]
    Cap --> StepLoop{{for each step}}

    StepLoop --> IterLoop{{iter 0..MAX_ITER-1<br/>= 0..1}}
    IterLoop --> BudgetImpl{spawnCounter<br/>can consume 1?}
    BudgetImpl -->|no| BreakSteps[/break stepLoop/]
    BudgetImpl -->|yes| Impl[implementActivity<br/>implementCodex]
    Impl --> Snap[statusPorcelainActivity<br/>cheap]
    Snap --> Progress{iter &gt; 0 AND<br/>same as last snap?}
    Progress -->|yes| RestoreStep[restoreActivity<br/>step files]
    RestoreStep --> MarkDrop[mark<br/>dropped-no-progress]
    MarkDrop --> NextStep[/continue stepLoop/]

    Progress -->|no| Stat[diffStatActivity<br/>cheap]
    Stat --> Trivial{ins+del &lt; 30<br/>AND files &lt; 3?}
    Trivial -->|yes| MarkSkip[mark<br/>parliament-skipped]
    MarkSkip --> NextStep

    Trivial -->|no| BudgetRev{remaining<br/>≥ 2?}
    BudgetRev -->|no| BreakSteps
    BudgetRev -->|yes| DiffText[diffTextActivity<br/>cheap, ≤8 KiB]
    DiffText --> Review[Promise.all -<br/>reviewActivity correctness +<br/>reviewActivity quality<br/>reviewCodex]
    Review --> DriftSnap[statusPorcelainActivity<br/>drift audit, cheap]
    DriftSnap --> Drift{drift detected?}
    Drift -->|yes| RestoreDrift[restoreActivity<br/>drifted files]
    Drift -->|no| Aggregate
    RestoreDrift --> Aggregate{verdict?}

    Aggregate -->|any critical_block| RestoreAll[restoreActivity<br/>full restore]
    RestoreAll --> MarkBlock[mark<br/>rolled-back-critical-block]
    MarkBlock --> BreakSteps
    Aggregate -->|all ok| MarkConv[mark converged]
    MarkConv --> NextStep
    Aggregate -->|needs_revision| AppendFb[append blocking_issues<br/>+ suggestions to feedback]
    AppendFb --> IterEnd{iter == MAX_ITER-1?}
    IterEnd -->|no| IterLoop
    IterEnd -->|yes| MarkUnConv[mark<br/>dropped-not-converged<br/>restore step files]
    MarkUnConv --> NextStep

    NextStep --> StepLoop
    StepLoop -->|all steps done| FinalStatus[statusPorcelainActivity<br/>cheap]
    BreakSteps --> FinalStatus
    FinalStatus --> AnyChanges{entries == ∅?}
    AnyChanges -->|yes| RetNoChg([return<br/>skipped: 'no-changes']):::ret
    AnyChanges -->|no| Commit[commitAllActivity<br/>heavy]
    Commit --> Child[executeChild<br/>robustPRMergeWorkflow<br/>parentClosePolicy=ABANDON]
    Child --> RetOk([return prUrl /<br/>prNumber / merged]):::ret

    RetNoOp -.->|finally| Cleanup
    RetNoChg -.->|finally| Cleanup
    RetOk -.->|finally| Cleanup
    BreakSteps -.->|finally| Cleanup
    Cleanup[cleanupWorkspaceActivity<br/>cheap, CancellationScope.nonCancellable]:::finally

    classDef ret fill:#dff,stroke:#06a,color:#024
    classDef finally fill:#fee,stroke:#a00,color:#400
```

#### Spawn budget

ワークフロー側で `SpawnCounter` が **`MAX_SPAWNS = 16`** を強制する。
ワーストケース: `1 (context) + 1 (plan) + 2 steps × 2 iter × (1 implement + 2 reviewers) = 14`、
リトライバッファ +2。超過時は新規 spawn を停止し、現状を Phase 3 でレポート。

### `robustPRMergeWorkflow` (Child)

```mermaid
flowchart TD
    Start([start]) --> Push[pushBranchActivity]
    Push --> Create[createPRActivity]
    Create --> Wait[waitForCIActivity]
    Wait -->|success| Conflict[checkConflictActivity]
    Wait -->|failure| Fetch[fetchFailedRunLogsActivity]
    Wait -->|timeout| Timeout([throw CITimeout])
    Fetch --> Heal["heavyCodex.codexActivity<br/>(CI self-heal)"]
    Heal --> CommitH[commitAllActivity]
    CommitH --> PushH[pushBranchActivity]
    PushH --> Wait
    Conflict -->|noConflict| Merge[mergePRActivity]
    Conflict -->|conflict| Resolve["heavyCodex.codexActivity<br/>(conflict resolve)"]
    Resolve --> CommitR[commitAllActivity]
    CommitR --> PushR[pushBranchActivity]
    PushR --> Wait
    Merge --> Done([return prInfo])
```

`maxFixIterations` に達するまで CI 失敗・コンフリクトを修復する。

---

## Activity Proxy の対応

| Proxy | startToCloseTimeout | retry | 主な使用 Activity |
| --- | --- | --- | --- |
| `cheap` | 2m | 5回, exp ×2, max 30s | git の軽量 plumbing、gh 単発 read |
| `heavy` | 20m | 4回, exp ×2, max 5m | clone, push |
| `contextCodex` / `planCodex` / `reviewCodex` | 5m | 5回, exp ×3, max 10m | codex 役割活動 (短時間) |
| `implementCodex` | 30m | 5回, exp ×3, max 10m | codex 役割活動 (実装、長時間) |
| `heavyCodex` | 90m | 5回, exp ×3, max 10m | pr-lifecycle の CI 自己修復・コンフリクト解消 |
| `ciWait` | 70m | 3回 | waitForCIActivity (heartbeat + ポーリング) |

LLM 系 proxy は全て `codexQuotaFriendlyRetry` を共有し、429 / quota 系エラーを
`RateLimited` 型として受けて指数バックオフで待つ (10 分上限・5 試行)。
`PlannerOutputInvalid`, `MissingCredentials`, `InvalidGitRef` は
`nonRetryableErrorTypes` に列挙して即失敗させる。

---

## ContextArtifact パターン

```mermaid
flowchart LR
    Phase0[Phase 0:<br/>extractContextArtifactActivity] -->|ContextArtifact| State[(Workflow State<br/>contextArtifact)]
    State --> Plan[planActivity]
    State --> Impl[implementActivity]
    State --> Rev1[reviewActivity<br/>correctness]
    State --> Rev2[reviewActivity<br/>quality]
```

ワークフロー初期に 1 回だけ codex を呼び、リポジトリのサマリー
(`overview / conventions / interfaces`) を `ContextArtifact` として蒸留。
以降の役割プロンプトは全てこの artifact を **静的プリアンブル** に含めるため、
LLM プロバイダのプロンプトキャッシュが plan / implement / review 間で
ヒットする (= 同一バイト列の prefix)。

```
[ STATIC, cacheable ]                                    [ DYNAMIC, per-call ]
┌─────────────────────────────────────────────┐  ┌────────────────────────────┐
│ Global hard rules                            │  │ step JSON / diff /         │
│ Repository Context Artifact                  │  │ prior reviewer feedback    │
│ Role identity + checklist + output schema   │  │                             │
└─────────────────────────────────────────────┘  └────────────────────────────┘
```

---

## 取り扱う状態

### Workspace
`os.tmpdir()/repo-steward-workspaces/<repo>__<random>` に clone する。
`cleanupWorkspaceActivity` が finally で必ず削除。

`baseBranch` は shallow clone 後に `refs/remotes/origin/<baseBranch>` として明示的に fetch し、
その remote-tracking ref から `agent/refactor/<workflow-id>` を作る。これにより、GitHub repo の
default branch ではない `develop` / `release/*` などを Schedule の対象にしても、ローカル branch
未作成による checkout 失敗を避ける。

### Branch 命名
`agent/refactor/<workflow-id>` 形式。Workflow ID は Schedule からの起動毎にユニーク。

---

## Determinism 上の注意

- Workflow からは `Date.now()` / `Math.random()` / `process.env` / 直接 `fs` を呼ばない。
- 待機は `proxyActivities` 越しの heartbeating activity か `sleep()` を使う（`setTimeout` は非推奨）。
- ID は `workflowInfo().workflowId` から導出するか、Activity 側で生成して結果として返す。
- Workflow ファイル直下に副作用のある top-level コードを書かない（`workflowInfo()` も関数内のみで呼ぶ）。
- `extractContextArtifactActivity` の `generatedAt` は `workflowInfo().startTime` から導出 (deterministic)。

---

## 既知の制約と将来検討事項

1. **workdir が Pod ローカル**: 親 Workflow の Activity が確保した `workdir` を子 Workflow が継続利用する設計のため、
   両方が同一 Worker 上で実行される必要がある。スケール時は worker pool を分割するか
   workdir を共有ストレージに置くなどの再設計が必要。
2. **codex CLI の実フラグ**: `codex exec` の引数はバージョン依存。
   CI でバージョン固定し、互換性ブレが起きたら `src/activities/_internal/run-codex.ts` で吸収する。
3. **Replay テストが未整備**: `Worker.runReplayHistory` を使った履歴互換テストを追加すると、
   `pr-lifecycle.ts` のような長寿命ワークフローを安全にバージョンアップできる。
4. **Issue 駆動ルートの再追加**: 将来 `ai-ready` ラベル付き Issue を処理したくなったら、
   `github/list-ai-ready-issues.ts` / `github/update-issue-status.ts` を追加し、
   `issuePollerWorkflow` → `issueDrivenWorkflow` → `robustPRMergeWorkflow` の階層を組む。
5. **別 LLM の再導入**: claude を戻したい場合は `claude/` クラスタを別途追加し、
   `codex/` と並行する Activity Proxy として呼び分ければよい。
   現状は codex 一本で十分なので簡略化している。
