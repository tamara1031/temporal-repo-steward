# アーキテクチャ

## 全体構成

```
┌──────────────────────────────────────────────────────────────────────────┐
│  Temporal Cluster                                                        │
│  ┌──────────────────────┐                                                │
│  │ Schedule:            │                                                │
│  │  periodic-refactor   │                                                │
│  │  (cron: hourly)      │                                                │
│  └─────────┬────────────┘                                                │
│            │ start                                                        │
│            ▼                                                              │
│  periodicRefactorWorkflow                                                 │
│            │                                                              │
│            ▼                                                              │
│  robustPRMergeWorkflow (child)                                            │
│  ├─ pushBranch → createPR                                                 │
│  ├─ waitForCI ⇄ self-heal (codex)            ◀── retry                   │
│  ├─ checkConflict ⇄ resolve (codex)          ◀── retry                   │
│  └─ mergePR                                                               │
└──────────────────────────────────────────────────────────────────────────┘
                  │ poll task queue: repo-steward
                  ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  Worker Pod(s)                                                           │
│  - workflows: periodic / robustPRMerge                                   │
│  - activities: git / github / codex / cleanup                            │
│  - tools on PATH: gh, codex                                              │
└──────────────────────────────────────────────────────────────────────────┘
```

> 現在の実装は定期リファクタリング 1 本に絞っており、コード生成側は codex のみ。
> Issue 駆動ルートや別 LLM (claude など) を後で追加したくなったら、`robustPRMergeWorkflow`
> をリユーザブルな子ワークフローとしてそのまま再利用できる。

## Workflow の責務

### `periodicRefactorWorkflow`
1. `cloneRepoActivity`
2. `codexActivity` … 改善機会の調査 + 適用を 1 回の codex 呼び出しで完結
3. 変更が無ければ早期 return
4. `commitAllActivity`
5. `executeChild(robustPRMergeWorkflow)`

### `robustPRMergeWorkflow` (Child)
共通 PR ライフサイクル。`maxFixIterations` に達するまで CI / コンフリクトを修復。

```
push branch → create PR
  ↓
loop (≤ maxFixIterations):
  waitForCI
    ├─ success → checkConflict
    │    ├─ noConflict → mergePR → return
    │    └─ conflict   → codex resolve → push → loop
    ├─ failure → fetchFailedRunLogs → codex fix → push → loop
    └─ timeout → throw CITimeout
```

## Activity の責務とリトライ

| Activity | 性質 | startToClose | リトライ | 備考 |
| --- | --- | --- | --- | --- |
| `cloneRepoActivity` | I/O 重い | 20m | 4 attempts | `--depth 50` |
| `commitAllActivity` | 軽い | 2m | 5 attempts | 差分無しは `committed:false` |
| `pushBranchActivity` | 軽い | 20m | 4 attempts | `--force-with-lease` 任意 |
| `checkConflictActivity` | 軽い | 2m | 5 attempts | `MERGE_HEAD` 検知で安全に abort |
| `cleanupWorkspaceActivity` | 軽い | 2m | 5 attempts | finally で必ず呼ばれる |
| `createPRActivity` | 軽い | 2m | 5 attempts | gh pr create |
| `waitForCIActivity` | 長時間 | 70m | 3 attempts | `heartbeatTimeout: 2m` で進捗監視 |
| `fetchFailedRunLogsActivity` | 軽い | 2m | 5 attempts | gh run view --log-failed |
| `mergePRActivity` | 軽い | 2m | 5 attempts | `--auto --squash` |
| `codexActivity` | 重い | 20m | 4 attempts | analyze と apply を兼用。`changedFiles` を返す |

すべて `nonRetryableErrorTypes: ['MissingCredentials']`。
認証欠落は人間の介入が必須なので即座に失敗させる。

## 取り扱う状態

### Workspace
`os.tmpdir()/repo-steward-workspaces/<repo>__<random>` に clone する。
`cleanupWorkspaceActivity` が finally で必ず削除。

### Branch 命名
`agent/refactor/<workflow-id>` 形式。Workflow ID は Schedule からの起動毎にユニーク。

## Determinism 上の注意

- Workflow からは `Date.now()` / `Math.random()` / `process.env` / 直接 `fs` を呼ばない。
- 待機は `proxyActivities` 越しの heartbeating activity か `sleep()` を使う（`setTimeout` は非推奨）。
- ID は `workflowInfo().workflowId` から導出するか、Activity 側で生成して結果として返す。
- Workflow ファイル直下に副作用のある top-level コードを書かない（`workflowInfo()` も関数内のみで呼ぶ）。

## 既知の制約と将来検討事項

1. **workdir が Pod ローカル**: 親 Workflow の Activity が確保した `workdir` を子 Workflow が継続利用する設計のため、
   両方が同一 Worker 上で実行される必要がある。スケール時は worker pool を分割するか
   workdir を共有ストレージに置くなどの再設計が必要。
2. **codex CLI の実フラグ**: `codex exec` の引数はバージョン依存。
   CI でバージョン固定し、互換性ブレが起きたら `src/activities/codex.ts` で吸収する。
3. **Replay テストが未整備**: `Worker.runReplayHistory` を使った履歴互換テストを追加すると、
   `pr-lifecycle.ts` のような長寿命ワークフローを安全にバージョンアップできる。
4. **Issue 駆動ルートの再追加**: 将来 `ai-ready` ラベル付き Issue を処理したくなったら、
   `listAiReadyIssuesActivity` / `updateIssueStatusActivity` を `github.ts` に追加し、
   `issuePollerWorkflow` → `issueDrivenWorkflow` → `robustPRMergeWorkflow` の階層を組む。
5. **別 LLM の再導入**: claude を戻したい場合は `claude.ts` を別 activity として追加し、
   `codexActivity` と並行する Activity Proxy として呼び分ければよい。
   現状は codex 一本で十分なので簡略化している。
