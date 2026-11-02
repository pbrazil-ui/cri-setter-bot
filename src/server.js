// Check the environment BEFORE loading anything that talks to a service, so a missing variable prints one clear line.
import { config, validateConfig, configWarnings } from './config.js';

const missing = validateConfig();
for (const w of configWarnings()) console.warn(`[config] ${w}`);
if (missing.length) {
  console.error(`Missing env vars: ${missing.join(', ')}. See .env.example (and the service's Environment tab on Render).`);
  process.exit(1);
}

const { buildApp } = await import('./app.js');
const { startJobs } = await import('./jobs.js');

buildApp().listen(config.port, () => {
  console.log(`CRI setter bot on :${config.port} (db=${config.dbMode} sms=${config.smsMode} llm=${config.llmMode} email=${config.email.mode}/${config.email.sendMode} dropbox=${config.dropbox.mode})`);
  startJobs();
});
