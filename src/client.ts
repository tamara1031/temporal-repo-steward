/**
 * Helper for ad-hoc workflow starts and schedule management from a developer
 * machine. Production schedule install lives in scripts/schedule-setup.sh
 * (which uses the temporal CLI directly).
 */
import 'dotenv/config';
import { Client, Connection, ScheduleOverlapPolicy } from '@temporalio/client';
import { loadTemporalRuntimeConfig } from './runtime-config';
import { periodicRefactorWorkflow } from './workflows';

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
      'usage: ts-node src/client.ts --command=<install-schedule|run-once> --repo=<owner/repo> ' +
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
  const config = loadTemporalRuntimeConfig();
  const connection = await Connection.connect({
    address: config.address,
    tls: config.tls,
  });
  const client = new Client({
    connection,
    namespace: config.namespace,
  });

  switch (cli.command) {
    case 'install-schedule': {
      await client.schedule.create({
        scheduleId: `periodic-refactor-${cli.repo.replace('/', '__')}`,
        spec: { cronExpressions: [cli.cron] },
        action: {
          type: 'startWorkflow',
          workflowType: periodicRefactorWorkflow,
          args: [{ repoFullName: cli.repo, baseBranch: cli.baseBranch }],
          taskQueue: config.taskQueue,
        },
        policies: { overlap: ScheduleOverlapPolicy.SKIP },
      });
      console.log('Installed schedule for', cli.repo);
      break;
    }
    case 'run-once': {
      const handle = await client.workflow.start(periodicRefactorWorkflow, {
        args: [{ repoFullName: cli.repo, baseBranch: cli.baseBranch }],
        taskQueue: config.taskQueue,
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
