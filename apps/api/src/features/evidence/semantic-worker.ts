import 'dotenv/config';
import { pool } from '../../core/db';
import { processSemanticJobs } from './service';
import { LocalBgeCommandEngine, SemanticUnavailableError } from './semantic';

let stopping = false;
process.once('SIGINT', () => { stopping = true; });
process.once('SIGTERM', () => { stopping = true; });

const delay = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));

async function main() {
  let engine: LocalBgeCommandEngine;
  try {
    engine = new LocalBgeCommandEngine();
  } catch (error) {
    if (error instanceof SemanticUnavailableError) {
      throw new Error('Local semantic model configuration is incomplete');
    }
    throw error;
  }
  while (!stopping) {
    const results = await processSemanticJobs({ limit: 25, engine });
    if (!results.length) await delay(2_000);
  }
}

main().catch(() => {
  console.error('Semantic worker stopped with a safe configuration or runtime error');
  process.exitCode = 1;
}).finally(async () => {
  await pool.end();
});
