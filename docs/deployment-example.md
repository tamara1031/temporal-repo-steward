# Deployment Example (Reference Only)

> 実運用の Deployment / Secret / NetworkPolicy はこのリポジトリの homelab 側で
> 一括管理されます。ここに置く YAML はあくまでサンプルで、homelab 側の構成に
> 取り込む際の参照用です。

## 前提

- Worker はアウトバウンド通信のみ。Service / Ingress / HTTPRoute は不要です。
- 必要な認証情報:
  - `GITHUB_TOKEN` … GitHub PAT（環境変数）。必要権限は本ファイル末尾「GitHub PAT スコープ」を参照
  - `~/.codex/auth.json` … codex CLI のブラウザログイン後に生成される認証ファイル
    （ローカルで `codex login` を 1 度走らせて生成してから Secret 化）

## 環境変数

`repo-steward-config` ConfigMap 相当に渡したい値:

| Key | 既定値 | 用途 |
| --- | --- | --- |
| `TEMPORAL_ADDRESS` | `temporal-frontend.temporal.svc.cluster.local:7233` | Temporal Frontend |
| `TEMPORAL_NAMESPACE` | `default` | 名前空間 |
| `TEMPORAL_TASK_QUEUE` | `repo-steward` | Worker のタスクキュー |
| `TEMPORAL_MAX_CONCURRENT_ACTIVITIES` | `4` | アクティビティ並列度 |
| `TEMPORAL_MAX_CONCURRENT_WORKFLOWS` | `20` | ワークフロータスク並列度 |
| `TEMPORAL_TLS` | `false` | mTLS 利用時に `true` |

## サンプル: Deployment + Secret マウント

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: repo-steward-worker
  namespace: repo-steward
spec:
  # workdir はローカル emptyDir に置くため、PR ライフサイクル子ワークフローを
  # またいで同一 Pod 上で完結する必要があります。スケールするなら
  # 「issue/refactor 単位で完結する別 Worker プール」へ分割するか、
  # workdir を共有ボリュームに置く設計に変更してください。
  replicas: 1
  selector:
    matchLabels:
      app: repo-steward-worker
  template:
    metadata:
      labels:
        app: repo-steward-worker
    spec:
      automountServiceAccountToken: false
      securityContext:
        # 標準的な non-root pod。Pod 境界そのものを隔離単位として扱うので、
        # codex CLI 側は --sandbox danger-full-access で動かしており、bwrap
        # は走りません。ノードの seccomp / AppArmor / userns 関連の sysctl
        # をいじる必要はありません。
        runAsNonRoot: true
        runAsUser: 1001
        fsGroup: 1001
      containers:
        - name: worker
          image: ghcr.io/<owner>/temporal-repo-steward:preview
          envFrom:
            - configMapRef:
                name: repo-steward-config
          env:
            - name: GITHUB_TOKEN
              valueFrom:
                secretKeyRef:
                  name: github-token
                  key: token
            - name: HOME
              value: /home/agent
          volumeMounts:
            # codex は $CODEX_HOME (= ~/.codex) 配下に session rollout / history.jsonl /
            # log を書き出すため、ディレクトリ全体を readOnly Secret で覆うと
            # `Error: Read-only file system (os error 30)` で exit 1 する。
            # auth.json だけを subPath でファイル単位マウントし、ディレクトリ自体は
            # 書き込み可能な emptyDir にする。
            - name: codex-state
              mountPath: /home/agent/.codex
            - name: codex-auth
              mountPath: /home/agent/.codex/auth.json
              subPath: auth.json
              readOnly: true
            - name: workspaces
              mountPath: /workspaces
          resources:
            requests: { cpu: "500m", memory: "1Gi" }
            limits:   { cpu: "2",    memory: "4Gi" }
      volumes:
        - name: codex-auth
          secret:
            secretName: codex-auth
            items:
              - key: auth.json
                path: auth.json
            defaultMode: 0400
        - name: codex-state
          emptyDir:
            sizeLimit: 256Mi
        - name: workspaces
          emptyDir:
            sizeLimit: 10Gi
```

## サンプル: Secret 投入コマンド

事前にローカルで `codex login`（ブラウザフロー）を実行し、`~/.codex/auth.json` を生成しておきます。

```bash
kubectl -n repo-steward create secret generic github-token \
  --from-literal=token="$GITHUB_TOKEN"

kubectl -n repo-steward create secret generic codex-auth \
  --from-file=auth.json="$HOME/.codex/auth.json"
```

> auth.json はリフレッシュトークンを含みます。ローテーションは
> `codex login` をやり直して Secret を再投入する形になります。

## サンプル: NetworkPolicy（アウトバウンド限定）

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: repo-steward-outbound-only
  namespace: repo-steward
spec:
  podSelector:
    matchLabels:
      app: repo-steward-worker
  policyTypes: [Ingress, Egress]
  ingress: []
  egress:
    - to:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: temporal
      ports:
        - { protocol: TCP, port: 7233 }
    - ports:
        - { protocol: TCP, port: 53 }
        - { protocol: UDP, port: 53 }
    - to: []
      ports:
        - { protocol: TCP, port: 443 }
```

## GitHub PAT スコープ

### Fine-grained PAT（推奨。対象 repo のみにスコープ）

| 権限 | レベル | 用途 |
| --- | --- | --- |
| Contents | Read & Write | clone / branch 作成 / push |
| Pull requests | Read & Write | PR 作成 / マージ |
| Actions | Read | `gh run view --log-failed` |
| Workflows | Read & Write | `.github/workflows/*.yml` を変更する PR を作る場合 |
| Metadata | Read | 自動付与 |

### Classic PAT（簡易。owner 全体に効く）

- `repo` — Contents / PR / Actions / Issues すべて
- `workflow` — `.github/workflows` 配下の編集

### Secret 投入時の注意

- Secret は kubectl `create secret generic` で投入する際、PAT が shell 履歴に残る。
  `kubectl create -f -` で stdin 経由にすると履歴を汚さない:
  ```bash
  read -s GITHUB_TOKEN  # 入力エコーされない
  printf '%s' "$GITHUB_TOKEN" \
    | kubectl -n repo-steward create secret generic github-token \
        --dry-run=client -o yaml --from-file=token=/dev/stdin \
    | kubectl apply -f -
  ```
- 期限切れ時の挙動は `gh` / `git` 側の 401 で失敗 → Activity リトライ → Workflow 失敗。
  Temporal Web UI で `401 Unauthorized` を見たら PAT 期限切れを疑うこと。

## Schedule の登録

`scripts/schedule-setup.sh` を Worker Pod もしくは管理者端末で実行してください。
`temporal` CLI が解決できる Cluster へ向けて
`periodicRefactorWorkflow` の Schedule を upsert します。

```bash
TEMPORAL_ADDRESS=temporal-frontend.temporal.svc.cluster.local:7233 \
TEMPORAL_NAMESPACE=default \
AGENT_REPO=<owner>/<repo> \
AGENT_BASE_BRANCH=main \
./scripts/schedule-setup.sh
```
