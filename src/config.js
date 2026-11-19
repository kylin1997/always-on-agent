import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const defaults = JSON.parse(readFileSync(new URL('../config/default.json', import.meta.url)));

export function loadConfig(env = process.env) {
  const config = {
    ...defaults,
    dataDir: resolve(env.DATA_DIR ?? defaults.dataDir),
    provider: env.MODEL_PROVIDER ?? defaults.provider,
    model: env.OLLAMA_MODEL ?? defaults.model,
    ollamaUrl: (env.OLLAMA_URL ?? defaults.ollamaUrl).replace(/\/$/, ''),
  };
  for (const [key, name, min, max] of [
    ['port', 'PORT', 1, 65535],
    ['pollMs', 'POLL_MS', 50, 60000],
    ['leaseMs', 'LEASE_MS', 5000, 3600000],
    ['minIntervalMs', 'MIN_INTERVAL_MS', 0, 60000],
    ['dreamEverySeconds', 'DREAM_EVERY_SECONDS', 0, 31536000],
  ]) {
    const value = Number(env[name] ?? defaults[key]);
    if (!Number.isInteger(value) || value < min || value > max) {
      throw new Error(`${name} must be an integer in [${min}, ${max}]`);
    }
    config[key] = value;
  }
  if (env.RISK_RULES) config.riskRules = { ...defaults.riskRules, ...JSON.parse(env.RISK_RULES) };
  for (const tool of ['get_time', 'set_timer']) {
    if (!['allow', 'block'].includes(config.riskRules[tool])) {
      throw new Error(`${tool} supports allow or block`);
    }
  }
  if (!['ask', 'block'].includes(config.riskRules.send_external)) {
    throw new Error('send_external requires approval or must be blocked');
  }
  return config;
}
