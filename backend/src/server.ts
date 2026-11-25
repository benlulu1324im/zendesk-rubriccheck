import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { SqliteRepository } from './db/repository.js';

const config = loadConfig();
const repo = new SqliteRepository(config.sqlitePath);
const app = createApp({ config, repo });

serve(
  {
    fetch: app.fetch,
    port: config.port,
  },
  (info) => {
    console.log(
      `[RubricCheck QA] Backend listening on http://localhost:${info.port} (paddle=${config.paddleEnv}, model=${config.geminiDecisionModel})`,
    );
  },
);
