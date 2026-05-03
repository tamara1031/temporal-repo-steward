# temporal-repo-steward

Pull 型・Webhook 不要・Temporal 駆動の自律 AI エージェント基盤。
定期的にリポジトリを巡回してリファクタ PR を出し、CI が落ちたら自己修復してマージまで完遂する。

```
Temporal Schedule ──▶ periodicRefactorWorkflow ──▶ robustPRMergeWorkflow (child) ──▶ merge
```

## できること

- **定期リファクタ**: Schedule で起動 → codex がコードを解析・適用 → PR → 自動 CI 修復 → マージ。
- **CI 自己修復ループ**: `gh run view --log-failed` を codex に渡して fix → push → 再度 CI 待機。
- **コンフリクト解消ループ**: `git merge --no-commit` でトライアル → codex で解消 → push → CI へ戻る。
- **外部干渉に強い**: CI 待機中に PR が外部で close / merge されても throw せず正常終了。
  別 PR が先に merge されたケースは workflow 内で短絡する。
- **Advisor (上位モデル相談)**: 2 回目以降の self-heal や no-diff の場面で `ADVISOR_MODEL`
  に問い合わせ、`{verdict: retry|abort|change-strategy}` を取得。abort なら早期停止。
  入力は事前に集約したサマリー（≤ 2 KiB）で、tokens は最小限。`maxAdvisorConsults`
  （既定 2）でハードキャップ。設定なしなら codex のデフォルトモデルを使う。
- **post-merge ポーリング**: `gh pr merge --auto` の "merge 要求" と "実際の merge 完了"
  を区別。observe で MERGED が見えるまでポーリングし、見えなければ `merge-queued` を返す。

> Issue 駆動ルートと Claude 連携はいったん外しています。
> 復活させるときは `robustPRMergeWorkflow` を子として再利用すれば容易に追加可能。

## ディレクトリ構成

```
.
├── Dockerfile              # Node20 + gh + codex
├── docker-compose.yml      # Temporal dev + Worker のローカル一括起動
├── package.json            # @temporalio/* (~1.11)
├── tsconfig.json
├── .env.example            # Worker が読む環境変数のテンプレート
├── .dockerignore
├── scripts/
│   └── schedule-setup.sh   # temporal schedule create --upsert
├── src/
│   ├── constants.ts        # TASK_QUEUE
│   ├── worker.ts           # Worker 起動エントリ
│   ├── client.ts           # 開発用クライアント (install-schedule / run-once)
│   ├── activities/
│   │   ├── exec.ts         # spawn ラッパー (heartbeat + cancellation)
│   │   ├── git.ts          # clone / commit / push / conflict 検知
│   │   ├── github.ts       # gh CLI: PR, CI poll, merge
│   │   ├── codex.ts        # codex exec (analyze + apply 統合)
│   │   └── index.ts
│   └── workflows/
│       ├── proxies.ts      # proxyActivities の cheap / heavy / ciWait
│       ├── periodic.ts     # periodicRefactorWorkflow
│       ├── pr-lifecycle.ts # robustPRMergeWorkflow
│       └── index.ts
├── tests/
│   ├── exec.test.ts
│   ├── periodic.test.ts
│   ├── pr-lifecycle.test.ts
│   └── helpers.ts
└── docs/
    ├── architecture.md
    └── deployment-example.md
```

## クイックスタート (ローカル)

```bash
# 1. Temporal dev サーバを別ターミナルで起動
temporal server start-dev

# 2. 依存インストール
npm install

# 3. codex CLI にブラウザでログイン（~/.codex/auth.json が生成される）
codex login

# 4. .env を整えて Worker を起動
cp .env.example .env
$EDITOR .env       # GITHUB_TOKEN を入れる
npm run start.worker.dev

# 5. Schedule をインストール
npm run start.client -- --command=install-schedule --repo=<owner>/<repo>

# 6. テスト (TestWorkflowEnvironment が裏でローカル Temporal を起動)
npm test
```

詳細は [`docs/architecture.md`](./docs/architecture.md) と [`docs/deployment-example.md`](./docs/deployment-example.md)。

## 認証情報

| 認証 | 形式 | 用途 |
| --- | --- | --- |
| `GITHUB_TOKEN` | env var | `gh` / `git push` |
| `~/.codex/auth.json` | JSON ファイル | codex CLI（`codex login` で生成） |

`OPENAI_API_KEY` は使いません。codex CLI のブラウザログインで作られる `auth.json`
を Worker にマウントする方式です（`CODEX_HOME` でディレクトリを上書き可）。

### GitHub PAT に必要な権限

PAT は **agent が PR を出すことになる対象 repo** に対して以下の権限が必要です。

#### 推奨: Fine-grained PAT（単一 repo にスコープ）

| 権限 | レベル | 用途 |
| --- | --- | --- |
| `Contents` | Read & Write | clone / branch 作成 / push |
| `Pull requests` | Read & Write | PR 作成 / マージ |
| `Actions` | Read | `gh run view --log-failed`（CI 失敗ログ取得） |
| `Workflows` | Read & Write | `.github/workflows/*.yml` を編集する PR を作る場合に必要 |
| `Metadata` | Read | 全 fine-grained PAT で自動付与 |

> Workflows 権限を外すとリファクタが workflow ファイルを触ったときに push が拒否されます。
> 不安なら最初は付けて、運用後に必要性を見直してください。

#### 簡易: Classic PAT

最低限のスコープ:

- `repo`（フルアクセス。Contents / PR / Actions / Workflows をまとめてカバー）
- `workflow`（`.github/workflows` への書き込みが発生する場合）

> Classic PAT はオーナー全体にアクセスが行くため、可能なら fine-grained を推奨。

#### 失効と更新

- 期限を 90 日 など短めに設定し、Secret ローテーションの運用を作っておくこと。
- 失効した場合 Worker は `MissingCredentials` ではなく `gh` / `git` の 401 で失敗します。
  Activity リトライ上限まで粘った後に Workflow が失敗する。Temporal Web UI（`:8233`）の
  失敗履歴で `401 Unauthorized` を見つけたら PAT 期限切れを疑う。

実運用 (Kubernetes) では Secret として homelab 側で管理。サンプルマニフェストは
[`docs/deployment-example.md`](./docs/deployment-example.md) を参照。

## 主要な設計判断

- **Pull 型**: 受信エンドポイント無し。すべて Temporal Schedule から起動する。Service / Ingress / HTTPRoute は不要。
- **CI 待機は heartbeating activity**: 数分〜1 時間級の待ちを Workflow 内で `sleep` せず、Activity 側でポーリング + heartbeat。
- **PR ライフサイクルは Child Workflow**: 上位 Workflow から再利用可能（後で Issue 駆動を足すときも同じ子を呼べばよい）。
- **Activity リトライは段階別**: 軽量 (gh read 系) / 重量 (codex) / CI 待機 で別ポリシー。すべて `MissingCredentials` のみ非リトライ。
- **Determinism**: Workflow から `Date.now()` / `Math.random()` / 直接 `process.env` を呼ばない。すべて Activity に閉じ込める。

## CI と branch protection

`.github/workflows/ci.yml` には 2 つの job があります:

| Job | 内容 | PR 時 | main push 時 |
| --- | --- | --- | --- |
| `build / lint / test` | npm の build / lint / lint.tests / test | ✅ | ✅ |
| `docker image` | `Dockerfile` ビルド + GHCR へ push | build のみ | `ghcr.io/<owner>/<repo>:preview` で push |

`:preview` タグは main の最新コミットを指す追跡タグ。安定版を切る運用にするときは
`:v0.x.y` 等のタグを別途付ける（push 設計を拡張する）想定。

### Branch protection（必須）

**Agent が出した PR を CI で gate するには、main の branch protection 設定が必須**です:

1. GitHub repo の `Settings → Branches → Branch protection rules → Add rule`
2. `Branch name pattern: main`
3. ✅ `Require a pull request before merging`
4. ✅ `Require status checks to pass before merging`
   - `Require branches to be up to date before merging`
   - 必須チェックに `build / lint / test` と `docker image` を追加
5. ✅ `Do not allow bypassing the above settings`（オプション、より厳格に）

これを設定しないと `gh pr merge --auto` が CI red でも素通しでマージしてしまいます。

### GHCR パッケージの可視性

初回 push 時に `ghcr.io/<owner>/<repo>` パッケージが自動作成されます。
デフォルトは private。public にする場合は GitHub の Packages 画面から
visibility を切り替え、Repository に link することで以降の push が同じパッケージへ届きます。

`mergePRActivity` は `--auto --squash --delete-branch` を使うので、CI が green
になった瞬間に **agent が自動でマージ** します。怖い場合は
`src/activities/github.ts` の `args` から `--auto` を一時的に外して
「PR 作成までで止めて人間が確認」運用にしてください。

## 既知の制約

- `workdir` がローカル FS にあるため、ある Refactor の処理は同一 Pod 内で完結する必要がある。
  Worker をスケールするときは「同 Workflow は同 Pod に貼り付く」ことが保証される構成にするか、
  `workdir` を共有ボリュームに置くか、子 Workflow で再 clone する設計に変更する。
- `codex` CLI のフラグは公開ドキュメント時点のもの。バージョン差異がある場合は
  `src/activities/codex.ts` を調整する。
- 単体テストは未同梱。Replay テスト ([Temporal TS SDK の testing ガイド](https://docs.temporal.io/develop/typescript/testing-suite))
  を CI に追加することを推奨。
