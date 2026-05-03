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
        Activities["Activities<br/>(advisor / codex / git / github / refactor)"]
    end

    Periodic -.->|"poll<br/>task queue"| Activities
    Robust -.->|"poll<br/>task queue"| Activities

    Activities -->|gh CLI / git / codex / advisor codex| External[(GitHub<br/>+ codex API)]
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
│   └── run-codex.ts               # `codex exec` ラッパ + 429 検知 (sandbox 切替対応)
│
├── advisor/                       # 上位モデル相談 (read-only sandbox)
│   ├── index.ts
│   └── advisor.ts                 # consultAdvisorActivity
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
│   ├── wait-for-ci.ts             # waitForCIActivity (state も同時取得)
│   ├── fetch-failed-logs.ts       # fetchFailedRunLogsActivity
│   ├── merge-pr.ts                # mergePRActivity (--auto)
│   └── observe-pr-state.ts        # observePRStateActivity (post-merge poll)
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
        RunCodex["run-codex.ts<br/>runCodexExec<br/>(--sandbox 切替 + 429 検知)"]
    end

    subgraph advisor_cluster["advisor/"]
        AdvAct["consultAdvisorActivity<br/>(read-only sandbox)"]
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
        GhActs["create-pr / wait-for-ci /<br/>fetch-failed-logs / merge-pr /<br/>observe-pr-state"]
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
    AdvAct --> RunCodex
    RunCodex --> Exec
    GitEnv --> Exec
```

`_internal/` の中身は同じクラスタ内のみで使う。クロスクラスタ参照は
`activities/_internal/` に置いた共有 (`exec` / `run-codex`) のみ許す。

---

## Workflow の責務

### `periodicRefactorWorkflow`

5 フェーズ + ステップループ + finally のフロー。守りどころ（リターン経路 / 巻き戻し /
finally）だけを残して、ガード判定・ハウスキープ Activity は省略しています。詳細は
コード（`src/workflows/periodic.ts`）を参照。

```mermaid
flowchart TD
    Start([start]) --> Clone[① clone]
    Clone --> Ctx[② context]
    Ctx --> Plan[③ plan]
    Plan -->|no-op / 空| RetSkip([skipped]):::ret
    Plan --> StepLoop[④ step loop<br/>≤2 steps × ≤2 iter]

    subgraph step["per step / per iter"]
        direction TB
        Impl[implement] --> Gate{trivial diff?}
        Gate -->|yes| StepDone[step done]
        Gate -->|no| Review["parliament<br/>(correctness ‖ quality)"]
        Review --> Verdict{verdict}
        Verdict -->|all ok| StepDone
        Verdict -->|needs_revision| Impl
        Verdict -->|critical_block| AdviseCB{"consult advisor<br/>(if budget)"}
        AdviseCB -->|verdict=retry| Impl
        AdviseCB -->|abort / change-strategy / no consult| RBall[full restore]
    end

    StepLoop --> step
    step -->|loop next step| StepLoop
    StepLoop --> Final{any changes?}
    RBall --> Final
    Final -->|no| RetSkip
    Final -->|yes| Commit[⑤ commit]
    Commit --> Child[child:<br/>robustPRMergeWorkflow<br/>ParentClosePolicy=ABANDON]
    Child --> RetOk([prUrl / merged + advisorAudits]):::ret

    RetSkip -.->|finally| Cleanup
    RetOk -.->|finally| Cleanup
    Cleanup[cleanup workspace<br/>nonCancellable]:::finally

    classDef ret fill:#dff,stroke:#06a,color:#024
    classDef finally fill:#fee,stroke:#a00,color:#400
```

省略している保守ロジック（ガード）— コードに存在するが図上は隠している:

- 各 codex spawn 前の `SpawnCounter` 残高チェック（超過なら step ループ脱出）
- iter > 0 で porcelain 出力が前回と完全一致なら「進捗なし」として step を drop
- Parliament 後の drift audit (`statusPorcelain` 再取得 → 増分があれば `restore`)
- `iter == MAX_ITER-1` 到達で needs_revision のままなら step を drop（`dropped-not-converged`）

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
    Wait -->|failure| AdviseFail{"iter ≥ 2?<br/>consult advisor"}
    Wait -->|timeout| Timeout([throw CITimeout])
    Wait -->|closed externally| ClosedExt([return closed-externally]):::ret
    Wait -->|merged externally| MergedExt([return merged-externally]):::ret
    AdviseFail -->|verdict=abort| AbortAdv([throw AdvisorAbort])
    AdviseFail -->|verdict=retry / change| Fetch[fetchFailedRunLogsActivity]
    Fetch --> Heal["heavyCodex.codexActivity<br/>(CI self-heal)"]
    Heal --> CommitH[commitAllActivity]
    CommitH -->|committed=false| AdviseNoDiff{"consult advisor<br/>(if budget)"}
    AdviseNoDiff --> ThrowNoDiff([throw NoFixDiff])
    CommitH -->|committed=true| PushH[pushBranchActivity]
    PushH --> Wait
    Conflict -->|noConflict| PreMerge["observePRStateActivity<br/>(pre-merge gate)"]
    Conflict -->|conflict| Resolve["heavyCodex.codexActivity<br/>(conflict resolve)"]
    Resolve --> CommitR[commitAllActivity]
    CommitR --> PushR[pushBranchActivity]
    PushR --> Wait
    PreMerge -->|MERGED| MergedRace([return merged-externally]):::ret
    PreMerge -->|CLOSED| ClosedRace([return closed-externally]):::ret
    PreMerge -->|OPEN| MergeReq[mergePRActivity<br/>--auto]
    MergeReq --> Poll["pollUntilMerged<br/>(observePRStateActivity ×N)"]
    Poll -->|MERGED observed| RetMerged([return merged]):::ret
    Poll -->|exhausted polls| RetQueued([return merge-queued]):::ret
    Poll -->|CLOSED after merge req| RetClosedPoll([return closed-externally]):::ret

    classDef ret fill:#dff,stroke:#06a,color:#024
```

`maxFixIterations` に達するまで CI 失敗・コンフリクトを修復する。
Advisor は `maxAdvisorConsults`（既定 2）が上限。各 advisor 呼び出しは
事前に集約済みのサマリー（≤ 2 KiB）のみを上位モデルに渡し、`{verdict, rationale, suggestedAction}`
を返す。verdict が `abort` のときのみ workflow を停止し、`retry` / `change-strategy`
は次の self-heal を続行する（提案は PR body・ログに記録）。

#### 新しい終了ステータス

`RobustPRMergeOutput.outcome` で `gh pr merge --auto` の挙動と外部干渉を区別する:

| outcome | 意味 | merged フラグ |
| --- | --- | --- |
| `merged` | merge が実際に landed（`mergedAt` を観測） | true |
| `merge-queued` | gh が `--auto` を受理したが、protection の up-to-date 待ちなど未完了 | false |
| `auto-merge-disabled` | 呼び出し側が `autoMerge=false` で停止 | false |
| `closed-externally` | 別 PR / 人間が PR を Close した | false |
| `merged-externally` | base force-push や手動 merge で観測 MERGED | true |

`closed-externally` / `merged-externally` は throw せず正常終了する。CI 待機中に
`gh pr view --json state` で OPEN/CLOSED/MERGED を毎ポーリング読み取り、
状態遷移を early-exit に変換することで「自分の PR より先に他の PR が merge された」
ケースを安全に処理する。

---

## Activity Proxy の対応

| Proxy | startToCloseTimeout | retry | 主な使用 Activity |
| --- | --- | --- | --- |
| `cheap` | 2m | 5回, exp ×2, max 30s | git の軽量 plumbing、gh 単発 read |
| `heavy` | 20m | 4回, exp ×2, max 5m | clone, push |
| `contextCodex` / `planCodex` / `reviewCodex` | 5m | 5回, exp ×3, max 10m | codex 役割活動 (短時間) |
| `implementCodex` | 30m | 5回, exp ×3, max 10m | codex 役割活動 (実装、長時間) |
| `heavyCodex` | 90m | 5回, exp ×3, max 10m | pr-lifecycle の CI 自己修復・コンフリクト解消 |
| `advisor` | 4m | 3回, exp ×2, max 2m | consultAdvisorActivity (上位モデル相談) |
| `ciWait` | 70m | 3回 | waitForCIActivity (heartbeat + ポーリング) |

LLM 系 proxy は全て `codexQuotaFriendlyRetry` を共有し、429 / quota 系エラーを
`RateLimited` 型として受けて指数バックオフで待つ (10 分上限・5 試行)。
`PlannerOutputInvalid`, `MissingCredentials`, `InvalidGitRef` は
`nonRetryableErrorTypes` に列挙して即失敗させる。

---

## Advisor consults（上位モデル相談）

Advisor は **「迷ったときに上位モデルに薄く意見を聞く」** ための単一 Activity
（`consultAdvisorActivity`）。実体は `codex exec --model $ADVISOR_MODEL --sandbox read-only`
の薄いラッパーで、コードを書き換えることはない。ワークフローからは
`workflows/_internal/advisor.ts` の `consultAdvisor()` ヘルパー経由で呼ぶ。

### 起動条件（gate）

| Gate | 場所 | 既定動作 | advisor の verdict が効く場面 |
| --- | --- | --- | --- |
| `ci-self-heal` | pr-lifecycle, iter ≥ 2 で CI red | self-heal を続行 | `abort` で workflow を停止（`AdvisorAbort`） |
| `no-diff` | pr-lifecycle, codex が diff を出さなかった時 | `NoFixDiff` を throw | 監査記録のみ（throw は変えない） |
| `critical-block` | periodic, reviewer が critical_block | 全 restore + 終了 | `retry` だけが効き、needs_revision に降格 |

### I/O 契約

入力（呼び出し側で集約済み・最大 ~2 KiB）:
- `situation`: 1 行で「どの分岐点か」
- `summary`: 失敗ジョブ名・上位 issue・iter 番号などの圧縮済みコンテキスト
- `options`: workflow が選びうる候補（advisor がそれを参考にする）

出力 JSON:
```json
{ "verdict": "retry" | "abort" | "change-strategy", "rationale": "...", "suggested_action": "..." }
```

### 予算（budget）

| Workflow | 既定 cap | 上書き |
| --- | --- | --- |
| `robustPRMergeWorkflow` | `maxAdvisorConsults = 2` | 入力で増減可 |
| `periodicRefactorWorkflow` | `maxAdvisorConsults = 1` | 0 で完全無効化 |

`AdvisorBudget` は `_internal/advisor.ts` の workflow-local カウンタ。**activity を
await する前に consume する** ため、activity が失敗してもカウントは消費される
（指数的なリトライループを防ぐ意図）。

### 失敗モード

advisor の activity が `AdvisorOutputInvalid` を投げた / `RateLimited` リトライ
が尽きた / 単に予算切れ — いずれの場合も `consultAdvisor()` は `reply: undefined`
で audit エントリだけ返す。呼び出し側はそれを「相談しなかった」と等価に扱い、
通常分岐（self-heal 続行 / 全 restore / NoFixDiff throw）にフォールスルーする。

### 監査トレース

各 consult は `AdvisorAuditEntry { gate, situation, reply?, error? }` として
収集され、`PeriodicRefactorOutput.advisorAudits` および
`RobustPRMergeOutput.advisorAudits` に出力される。periodic の `renderReport`
は PR body に **「## Advisor consults」** セクションを生成し、verdict と
rationale を可視化する。子 workflow（pr-lifecycle）の consult は時系列上
PR body 生成より後なので、PR body には載らず periodic 出力経由で観測する。

### 環境変数

`ADVISOR_MODEL` を Worker に設定すると codex がそのモデルで起動する。
未設定なら codex のデフォルトモデルが使われ、advisor は事実上「同モデルでの
2nd opinion」として動く。本番では Opus / GPT-5 級のモデルを推奨。

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

## Activities catalog

Worker が登録する全 Activity の一覧。`src/activities/index.ts` の barrel が
ソース・オブ・トゥルース。proxy 列はワークフロー側の `proxyActivities` グループ
（`src/workflows/proxies.ts`）で、retry / timeout は **Activity Proxy の対応**
セクションを参照。

### `git/` — workspace + git plumbing

| Activity | ファイル | proxy | 役割 |
| --- | --- | --- | --- |
| `cloneRepoActivity` | `git/clone.ts` | `heavy` | shallow clone + `agent/refactor/<id>` ブランチ作成 |
| `commitAllActivity` | `git/commit.ts` | `heavy` | `git add -A` + commit。空 diff は `committed: false` |
| `pushBranchActivity` | `git/push.ts` | `heavy` | `git push` (`-u` / `--force-with-lease` 切替可) |
| `checkConflictActivity` | `git/check-conflict.ts` | `cheap` | base に対する trial merge → 衝突ファイル列挙 |
| `cleanupWorkspaceActivity` | `git/cleanup.ts` | `cheap` | finally で workdir を削除 |
| `diffStatActivity` | `git/diff-stat.ts` | `cheap` | Pre-Parliament gate 用の `--shortstat` |
| `diffTextActivity` | `git/diff-text.ts` | `cheap` | reviewer に渡す diff 本文（`maxBytes` 切詰め） |
| `statusPorcelainActivity` | `git/status-porcelain.ts` | `cheap` | drift 検知用 porcelain スナップショット |
| `restoreActivity` | `git/restore.ts` | `cheap` | `paths` 指定なし → 全ファイル restore（critical_block 用） |

### `github/` — gh CLI

| Activity | ファイル | proxy | 役割 |
| --- | --- | --- | --- |
| `createPRActivity` | `github/create-pr.ts` | `cheap` | `gh pr create` + view で `{number, url}` 取得 |
| `waitForCIActivity` | `github/wait-for-ci.ts` | `ciWait` | `statusCheckRollup` + `state` を polling。external close/merge も検知 |
| `fetchFailedRunLogsActivity` | `github/fetch-failed-logs.ts` | `cheap` | `gh run view --log-failed` (codex への入力) |
| `mergePRActivity` | `github/merge-pr.ts` | `cheap` | `gh pr merge --auto --squash --delete-branch` |
| `observePRStateActivity` | `github/observe-pr-state.ts` | `cheap` | `gh pr view --json state,mergedAt`（pre-merge gate / post-merge poll で利用） |

### `codex/` / `refactor/` / `advisor/` — LLM 系

| Activity | ファイル | proxy | sandbox | 役割 |
| --- | --- | --- | --- | --- |
| `codexActivity` | `codex/codex.ts` | `heavyCodex` | workspace-write | pr-lifecycle の CI 自己修復・コンフリクト解消 |
| `extractContextArtifactActivity` | `refactor/extract-context.ts` | `contextCodex` | workspace-write | repo summary を蒸留（workflow 開始時 1 回） |
| `planActivity` | `refactor/plan.ts` | `planCodex` | workspace-write | テーマ + ≤2 ステップに分解。Read-only 想定 |
| `implementActivity` | `refactor/implement.ts` | `implementCodex` | workspace-write | 1 ステップを working tree に適用 |
| `reviewActivity` | `refactor/review.ts` | `reviewCodex` | workspace-write | concern 別 reviewer (correctness / quality)。プロンプトで read-only 強制 + drift audit でも担保 |
| `consultAdvisorActivity` | `advisor/advisor.ts` | `advisor` | **read-only** | 上位モデル相談（gate ベース。budget で上限） |

---

## Configuration reference

Worker が読む環境変数と、Workflow / Schedule に渡す入力フィールドを 1 箇所にまとめる。
`.env.example` がキー一覧の正、本セクションは説明と既定値の正。

### Worker 環境変数

| Variable | 必須? | 既定値 | 用途 |
| --- | --- | --- | --- |
| `TEMPORAL_ADDRESS` | yes | `localhost:7233` | Temporal Frontend gRPC エンドポイント |
| `TEMPORAL_NAMESPACE` | no | `default` | Temporal 名前空間 |
| `TEMPORAL_TASK_QUEUE` | no | `repo-steward` | Worker / Client が共有するキュー名 |
| `TEMPORAL_TLS` | no | `false` | `true` で mTLS を有効化 |
| `TEMPORAL_MAX_CONCURRENT_ACTIVITIES` | no | `4` | Activity スロット数（codex の並列度に直結） |
| `TEMPORAL_MAX_CONCURRENT_WORKFLOWS` | no | `20` | Workflow タスクスロット数 |
| `NODE_ENV` | no | (unset) | `production` のとき pre-built bundle が無いと起動失敗 |
| `GITHUB_TOKEN` | yes | — | `gh` / `git push` の認証。fine-grained PAT 推奨 |
| `GIT_BOT_NAME` | no | `repo-steward-bot` | auto-commit の `user.name` |
| `GIT_BOT_EMAIL` | no | `ai-agent@users.noreply.github.com` | auto-commit の `user.email` |
| `CODEX_HOME` | no | `~/.codex` | `auth.json` を別パスにマウントする時に上書き |
| `ADVISOR_MODEL` | no | (unset → codex デフォルト) | `consultAdvisorActivity` が `codex exec --model` に渡すモデル名 |

### `periodicRefactorWorkflow` 入力 (`PeriodicRefactorInput`)

| Field | 型 | 既定値 | 説明 |
| --- | --- | --- | --- |
| `repoFullName` | `string` | (必須) | `owner/name` 形式 |
| `baseBranch` | `string?` | `main` | clone 時に fetch する base ref |
| `refactorBrief` | `string?` | (なし) | planner に渡すユーザー指示。空なら planner が自由にテーマ選択 |
| `autoMerge` | `boolean?` | `true` | `false` で child を merge 直前まで止める |
| `maxAdvisorConsults` | `number?` | `1` | advisor を呼べる回数。`0` で完全無効化 |

### `robustPRMergeWorkflow` 入力 (`RobustPRMergeInput`)

| Field | 型 | 既定値 | 説明 |
| --- | --- | --- | --- |
| `repoFullName` | `string` | (必須) | `owner/name` |
| `workdir` | `string` | (必須) | 親が確保した workdir。同 Pod 上で利用 |
| `branch` | `string` | (必須) | push 対象の branch |
| `baseBranch` | `string` | (必須) | merge 先 |
| `prTitle` / `prBody` | `string` | (必須) | PR の表示テキスト |
| `maxFixIterations` | `number?` | `8` | CI 修復 + コンフリクト解消の合計上限 |
| `autoMerge` | `boolean?` | `true` | `false` で `outcome: 'auto-merge-disabled'` で終了 |
| `maxAdvisorConsults` | `number?` | `2` | advisor 上限。`ci-self-heal` と `no-diff` で 1 ずつ消費 |
| `postMergePollAttempts` | `number?` | `6` | merge 確認 poll の最大回数 |
| `postMergePollIntervalMs` | `number?` | `10_000` | poll 間隔（ミリ秒） |

### Workflow 内ハードコード定数

| 定数 | 場所 | 値 | 意味 |
| --- | --- | --- | --- |
| `MAX_SPAWNS` | `periodic.ts` | `16` | codex 呼び出し総数の上限（context+plan+impl+review 全部含む） |
| `MAX_STEPS` | `periodic.ts` | `2` | planner が返したステップを切り詰める上限 |
| `MAX_ITER` | `periodic.ts` | `2` | 各ステップの implement→review ループ上限 |
| `TRIVIAL_LINE_THRESHOLD` | `periodic.ts` | `30` | これ未満の (ins+del) は Pre-Parliament Gate でスキップ |
| `TRIVIAL_FILE_THRESHOLD` | `periodic.ts` | `3` | これ未満の files-changed は Pre-Parliament Gate でスキップ |
| `REVIEW_DIFF_BYTES` | `periodic.ts` | `8 * 1024` | reviewer に渡す diff の最大バイト数 |
| `REVIEWER_CONCERNS` | `periodic.ts` | `['correctness', 'quality']` | Parliament の reviewer ロール |
| `CI_POLL_INTERVAL_SECONDS` | `pr-lifecycle.ts` | `30` | `waitForCIActivity` の polling 間隔（heartbeat とは独立） |
| `CI_MAX_WAIT_SECONDS` | `pr-lifecycle.ts` | `3600` | CI 待ちの上限（超えると `CITimeout`） |
| `POST_MERGE_POLL_ATTEMPTS` | `pr-lifecycle.ts` | `6` | 既定の merge 観測 poll 回数 |
| `POST_MERGE_POLL_INTERVAL_MS` | `pr-lifecycle.ts` | `10_000` | 既定の poll 間隔 |

---

## ApplicationFailure type catalog

operator が Temporal Web UI で見ることになる `ApplicationFailure.type` を一覧化する。
`Retryable?` 列は **Activity 側で投げた瞬間にリトライされるか** を示す。
`No (nonRetryable)` は `ApplicationFailure.nonRetryable()` で投げているため
proxy の RetryPolicy 設定とは無関係に即失敗。`No (workflow throw)` は
workflow コードからの throw なので Workflow 自体が失敗終了する。

| Type | 投げる場所 | Retryable? | 意味と対処 |
| --- | --- | --- | --- |
| `MissingCredentials` | `gh-env.ts` / `git-env.ts` / `run-codex.ts` | No (nonRetryable) | `GITHUB_TOKEN` 未設定 / `~/.codex/auth.json` 不在。Worker 環境を直す |
| `InvalidGitRef` | `git-env.ts` | No (nonRetryable) | base branch が空文字。Schedule 入力 / workflow 引数を直す |
| `InvalidGitHubOutput` | `gh-json.ts` | No (nonRetryable) | gh CLI の JSON が想定外。gh のバージョン更新 / API 仕様変更を疑う |
| `PlannerOutputInvalid` | `refactor/_internal/parsers.ts` | No (nonRetryable) | planner が JSON を返さなかった。プロンプトかモデルの問題。periodic は `skipped: 'plan-failed'` で着地 |
| `AdvisorOutputInvalid` | `advisor/advisor.ts` | No (nonRetryable, proxy 側で除外) | advisor が JSON を返さなかった。`reply: undefined` 扱いで通常分岐に落ちる |
| `RateLimited` | `run-codex.ts` | **Yes** | codex CLI の stderr/stdout に rate-limit 文字列。proxy の `codexQuotaFriendlyRetry` で指数バックオフ |
| `CodexInvocationError` | `run-codex.ts` | **Yes** | codex の非 0 終了。`RateLimited` 以外。リトライで救えなければ最終的に Workflow 失敗 |
| `CITimeout` | `pr-lifecycle.ts` (workflow) | No (workflow throw) | `CI_MAX_WAIT_SECONDS` 経過しても CI 未収束。GitHub 側を確認 |
| `AdvisorAbort` | `pr-lifecycle.ts` (workflow) | No (workflow throw) | iter ≥ 2 で advisor が `verdict: abort` を返した。意図的な早期停止 |
| `NoFixDiff` | `pr-lifecycle.ts` (workflow) | No (workflow throw) | codex が "fixed it" と言ったが diff が空。プロンプト誤解 / sandbox 問題を疑う |
| `MaxIterationsExceeded` | `pr-lifecycle.ts` (workflow) | No (workflow throw) | `maxFixIterations` まで使い切っても CI green に至らず |

`nonRetryableErrorTypes` に登録されている `MissingCredentials` / `InvalidGitRef` /
`PlannerOutputInvalid` / `AdvisorOutputInvalid` は `proxies.ts` の各 RetryPolicy
で除外されているため、proxy 経由でも 1 回でフェイルする。

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
