# Replay test fixtures

Drop saved Temporal workflow histories (`*.json`) here. The
`replay — production-captured histories (optional)` block in `tests/replay.test.ts`
auto-discovers every `.json` file in this directory and replays it against the
current workflow bundle.

## How to capture a production history

After a workflow execution you want to pin as a regression fixture:

```bash
temporal workflow show \
  --workflow-id <workflow-id> \
  --output-filename tests/fixtures/replay/<descriptive-name>.json \
  --output json
```

Or programmatically:

```typescript
import { Client, Connection } from '@temporalio/client';
const conn = await Connection.connect({ address: 'localhost:7233' });
const client = new Client({ connection: conn });
const handle = client.workflow.getHandle('<workflow-id>');
const history = await handle.fetchHistory();
await fs.promises.writeFile(
  'tests/fixtures/replay/<descriptive-name>.json',
  JSON.stringify(history, null, 2),
);
```

## Naming

Use `<workflow-type>-<scenario>.json`, e.g.:

- `periodic-happy-path.json`
- `periodic-critical-block-rollback.json`
- `pr-lifecycle-self-heal-2-iters.json`

The file name (minus `.json`) is passed as the `workflowId` to
`Worker.runReplayHistory`, so make sure each is unique.

## What replay catches

- New / removed / reordered activity calls in the workflow
- New timers (`sleep()`)
- New child-workflow starts
- Changed activity signatures used by the workflow

## What replay does NOT catch

- Activity-implementation bugs (activities are not replayed — their results
  are read from history)
- Wall-clock-time-dependent behavior (replay uses `workflowInfo().startTime`)
- Worker / cluster configuration drift
