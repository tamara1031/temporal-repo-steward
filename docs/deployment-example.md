# Deployment Example

> The authoritative Deployment / Secret / NetworkPolicy for production are managed in the homelab repository.  
> The manifests here are **reference examples** intended as a starting point.

## Prerequisites

- Worker makes outbound connections only — no Service, Ingress, or HTTPRoute required.
- Two secrets must be created before the Deployment starts:
  - `GITHUB_TOKEN` — GitHub PAT (see [GitHub PAT scopes](#github-pat-scopes))
  - `~/.codex/auth.json` — created by running `codex login` locally (browser flow)

## Environment variables

Variables typically placed in a `repo-steward-config` ConfigMap:

| Key | Default | Purpose |
| --- | --- | --- |
| `TEMPORAL_ADDRESS` | `temporal-frontend.temporal.svc.cluster.local:7233` | Temporal Frontend gRPC |
| `TEMPORAL_NAMESPACE` | `default` | Temporal namespace |
| `TEMPORAL_TASK_QUEUE` | `repo-steward` | Worker task queue |
| `TEMPORAL_MAX_CONCURRENT_ACTIVITIES` | `4` | Activity parallelism (= codex concurrency) |
| `TEMPORAL_MAX_CONCURRENT_WORKFLOWS` | `20` | Workflow task parallelism |
| `TEMPORAL_TLS` | `false` | Set `true` for mTLS |

## Deployment + Secret mounts

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: repo-steward-worker
  namespace: repo-steward
spec:
  # workdir lives in the container filesystem (os.tmpdir()).
  # Parent and child Workflows reuse the same workdir, so both must run on
  # the same pod.  To scale horizontally, either pin Workflows to a pod or
  # move workdir to a shared volume.
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
            # codex writes session files and logs to $HOME/.codex at runtime.
            # Mounting the Secret directory-wide as readOnly causes "Read-only
            # file system" errors.  Solution: writable emptyDir for the directory,
            # then auth.json as a single read-only file inside it via subPath.
            - name: codex-state
              mountPath: /home/agent/.codex
            - name: codex-auth
              mountPath: /home/agent/.codex/auth.json
              subPath: auth.json
              readOnly: true
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
```

## Creating secrets

Run `codex login` locally (browser flow) first to generate `~/.codex/auth.json`.

```bash
kubectl -n repo-steward create secret generic github-token \
  --from-literal=token="$GITHUB_TOKEN"

kubectl -n repo-steward create secret generic codex-auth \
  --from-file=auth.json="$HOME/.codex/auth.json"
```

> `auth.json` contains a refresh token. To rotate it, re-run `codex login` locally and recreate the secret.

To avoid leaking the PAT into shell history, use stdin:

```bash
read -rs GITHUB_TOKEN
printf '%s' "$GITHUB_TOKEN" \
  | kubectl -n repo-steward create secret generic github-token \
      --dry-run=client -o yaml --from-file=token=/dev/stdin \
  | kubectl apply -f -
```

## NetworkPolicy (egress-only)

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

## GitHub PAT scopes

### Fine-grained PAT (recommended — scoped to the target repo)

| Permission | Level | Purpose |
| --- | --- | --- |
| Contents | Read & Write | clone / branch / push |
| Pull requests | Read & Write | create PR / merge |
| Actions | Read | `gh run view --log-failed` (CI failure logs) |
| Workflows | Read & Write | Required when the refactor modifies `.github/workflows/*.yml` |
| Metadata | Read | Granted automatically |

### Classic PAT (simpler — applies to the entire owner)

- `repo` — Contents / PRs / Actions / Issues
- `workflow` — edit files under `.github/workflows`

### Token expiry

An expired token causes `gh`/`git` 401 errors that exhaust Activity retries before the Workflow fails.  
Look for `401 Unauthorized` in the Temporal Web UI failure history when diagnosing auth problems.

## Schedule setup

Run `scripts/schedule-setup.sh` from a Worker pod or an admin machine that can reach the Temporal cluster. It upserts a `periodicRefactorWorkflow` Schedule.

```bash
TEMPORAL_ADDRESS=temporal-frontend.temporal.svc.cluster.local:7233 \
TEMPORAL_NAMESPACE=default \
AGENT_REPO=<owner>/<repo> \
AGENT_BASE_BRANCH=main \
./scripts/schedule-setup.sh
```
