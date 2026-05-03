/**
 * Pre-bundle the workflow code for production. The Worker references the
 * emitted bundle via `workflowBundle: { codePath: ... }` instead of bundling
 * at process startup (which is slow and inappropriate for production per
 * Temporal's TypeScript guidance).
 *
 * Run via `npm run build:workflows`. Output: `dist/workflow-bundle.js`.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { bundleWorkflowCode } from '@temporalio/worker';

async function main(): Promise<void> {
  const distDir = path.resolve(__dirname, '..', 'dist');
  await fs.mkdir(distDir, { recursive: true });
  const outPath = path.join(distDir, 'workflow-bundle.js');

  const workflowsPath = require.resolve('../src/workflows');
  console.log(`[build-workflow-bundle] bundling ${workflowsPath}`);

  const { code } = await bundleWorkflowCode({ workflowsPath });
  await fs.writeFile(outPath, code, 'utf8');

  const sizeKb = Math.round(code.length / 1024);
  console.log(`[build-workflow-bundle] wrote ${outPath} (${sizeKb} KiB)`);
}

main().catch((err) => {
  console.error('[build-workflow-bundle] failed', err);
  process.exit(1);
});
