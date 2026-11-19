import { createModels, createProvider } from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { fauxProvider } from '@earendil-works/pi-ai/providers/faux';
import { fauxBrain } from './faux-brain.js';
import { credentialProxy } from './permissions.js';

export async function selectProvider(config) {
  if (config.provider !== 'ollama') return config.provider;
  try {
    const response = await fetch(`${config.ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(1500) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    await response.body?.cancel();
    return 'ollama';
  } catch (error) {
    console.warn(`Ollama unavailable (${error.message}). Start it with ollama serve. Using faux.`);
    return 'faux';
  }
}

export function createRunModel(config, provider, env = process.env) {
  const models = createModels();
  if (provider === 'faux') {
    const faux = fauxProvider();
    models.setProvider(faux.provider);
    return {
      model: faux.getModel(),
      stream(model, context, options) {
        faux.appendResponses([fauxBrain]);
        return models.streamSimple(model, context, options);
      },
    };
  }
  if (!['ollama', 'openai-compatible'].includes(provider)) throw new Error('Unknown MODEL_PROVIDER');
  const local = provider === 'ollama';
  const baseUrl = local ? `${config.ollamaUrl}/v1` : env.ONLINE_BASE_URL;
  const id = local ? config.model : env.ONLINE_MODEL;
  if (!baseUrl || !id) throw new Error('ONLINE_BASE_URL and ONLINE_MODEL are required');
  const endpoint = new URL(baseUrl);
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash
    || !['http:', 'https:'].includes(endpoint.protocol) || (!local && endpoint.protocol !== 'https:')) {
    throw new Error('Invalid model endpoint');
  }
  const getKey = credentialProxy(config.dataDir, env);
  models.setProvider(createProvider({
    id: provider,
    baseUrl,
    auth: { apiKey: {
      name: provider,
      resolve: async () => {
        const apiKey = local ? 'ollama' : getKey('ONLINE_API_KEY');
        if (!apiKey) throw new Error('ONLINE_API_KEY is required');
        return { auth: { apiKey } };
      },
    } },
    models: [{
      id, name: id, api: 'openai-completions', provider, baseUrl,
      reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: config.contextWindow, maxTokens: config.maxTokens,
      compat: { supportsDeveloperRole: false, supportsReasoningEffort: false, supportsStore: false },
    }],
    api: openAICompletionsApi(),
  }));
  const model = models.getModel(provider, id);
  if (!model) throw new Error(`Model unavailable: ${provider}/${id}`);
  return { model, stream: models.streamSimple.bind(models) };
}
