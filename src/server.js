import { config, validateConfig } from './config.js';
import { buildApp } from './app.js';
import { startJobs } from './jobs.js';

const missing = validateConfig();
if (missing.length) {
  console.error(`Missing env vars: ${missing.join(', ')}. See .env.example.`);
  process.exit(1);
}

buildApp().listen(config.port, () => {
  console.log(`CRI setter bot on :${config.port} (db=${config.dbMode} sms=${config.smsMode} llm=${config.llmMode})`);
  startJobs();
});
