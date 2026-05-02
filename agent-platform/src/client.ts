/**
 * Optional helper for ad-hoc workflow starts and schedule management
 * from a developer machine. Production schedule install lives in
 * k8s/schedule-setup.sh (which uses the temporal CLI directly).
 */
import { Client, Connection, ScheduleOverlapPolicy } from '@temporalio/client';
import { TASK_QUEUE } from './constants';
import { periodicRefactorWorkflow, issuePollerWorkflow } from './workflows';

interface CLIArgs {
  command: string;
  repo: string;
  baseBranch: string;
  cron: string;
}

function parseArgs(argv: string[]): CLIArgs {
  const args = Object.fromEntries(
    argv.slice(2).map((kv) => {
      const [k, ...rest] = kv.split('=');
      return [k.replace(/^--/, ''), rest.join('=')];
    }),
  ) as Record<string, string>;
  if (!args.command || !args.repo) {
    throw new Error(
      'usage: ts-node src/client.ts --command=<install-schedules|run-once> --repo=<owner/repo> ' +
        '[--base-branch=main] [--cron="0 * * * *"]',
    );
  }
  return {
    command: args.command,
    repo: args.repo,
    baseBranch: args['base-branch'] ?? 'main',
    cron: args.cron ?? '0 * * * *',
  };
}

async function main(): Promise<void> {
  const cli = parseArgs(process.argv);
  const connection = await Connection.connect({
    address: process.env.TEMPORAL_ADDRESS ?? 'localhost:7233',
  });
  const client = new Client({
    connection,
    namespace: process.env.TEMPORAL_NAMESPACE ?? 'default',
  });

  const taskQueue = process.env.TEMPORAL_TASK_QUEUE ?? TASK_QUEUE;

  switch (cli.command) {
    case 'install-schedules': {
      await client.schedule.create({
        scheduleId: `periodic-refactor-${cli.repo.replace('/', '__')}`,
        spec: { cronExpressions: [cli.cron] },
        action: {
          type: 'startWorkflow',
          workflowType: periodicRefactorWorkflow,
          args: [{ repoFullName: cli.repo, baseBranch: cli.baseBranch }],
          taskQueue,
        },
        policies: { overlap: ScheduleOverlapPolicy.SKIP },
      });
      await client.schedule.create({
        scheduleId: `issue-poller-${cli.repo.replace('/', '__')}`,
        spec: { intervals: [{ every: '5m' }] },
        action: {
          type: 'startWorkflow',
          workflowType: issuePollerWorkflow,
          args: [{ repoFullName: cli.repo, baseBranch: cli.baseBranch, taskQueue }],
          taskQueue,
        },
        policies: { overlap: ScheduleOverlapPolicy.SKIP },
      });
      console.log('Installed schedules for', cli.repo);
      break;
    }
    case 'run-once': {
      const handle = await client.workflow.start(periodicRefactorWorkflow, {
        args: [{ repoFullName: cli.repo, baseBranch: cli.baseBranch }],
        taskQueue,
        workflowId: `periodic-refactor-once-${Date.now()}`,
      });
      console.log('Started workflow', handle.workflowId);
      break;
    }
    default:
      throw new Error(`unknown command: ${cli.command}`);
  }

  await connection.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
