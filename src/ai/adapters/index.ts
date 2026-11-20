import type { Protocol } from '../../shared/ai';
import type { ProviderAdapter } from '../types';
import { openAiChatAdapter } from './openaiChat';
import { openAiResponsesAdapter } from './openaiResponses';
import { anthropicAdapter } from './anthropic';
import { geminiAdapter } from './gemini';
import { ollamaAdapter } from './ollama';

const ADAPTERS: Record<Protocol, ProviderAdapter> = {
  'openai-chat': openAiChatAdapter,
  'openai-responses': openAiResponsesAdapter,
  'anthropic-messages': anthropicAdapter,
  gemini: geminiAdapter,
  ollama: ollamaAdapter,
};

export function adapterFor(protocol: Protocol): ProviderAdapter {
  return ADAPTERS[protocol];
}
