import Anthropic from '@anthropic-ai/sdk';

import { withRetry } from './retry.js';

import type { AICompletionRequest, AICompletionResult, AIProvider } from './provider.js';

/**
 * Placeholder default model name. No real model-name string was found
 * anywhere in this repo at the time this file was written; this is a
 * placeholder pending a real models/pricing reference doc.
 */
export const DEFAULT_ANTHROPIC_MODEL = 'claude-placeholder-model';

const DEFAULT_MAX_TOKENS = 1024;

export interface AnthropicProviderOptions {
  apiKey: string;
  model?: string;
}

export interface AnthropicMessageParam {
  role: 'user';
  content: string;
}

export interface AnthropicCreateParams {
  model: string;
  max_tokens: number;
  messages: AnthropicMessageParam[];
}

export interface AnthropicContentBlock {
  type: string;
  text?: string;
}

export interface AnthropicMessageResponse {
  content: AnthropicContentBlock[];
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
}

/**
 * The minimal shape of `@anthropic-ai/sdk`'s `Anthropic` client that
 * `AnthropicProvider` depends on, so tests can inject a fake client instead
 * of touching the real network/SDK. Verified structurally compatible with
 * the real `Anthropic` client's `messages.create` (see
 * `node_modules/@anthropic-ai/sdk/resources/messages/messages.d.ts`).
 */
export interface AnthropicClientLike {
  messages: {
    create(params: AnthropicCreateParams): Promise<AnthropicMessageResponse>;
  };
}

export class AnthropicProvider implements AIProvider {
  private readonly model: string;
  private readonly client: AnthropicClientLike;

  constructor(options: AnthropicProviderOptions, client?: AnthropicClientLike) {
    this.model = options.model ?? DEFAULT_ANTHROPIC_MODEL;
    this.client = client ?? new Anthropic({ apiKey: options.apiKey });
  }

  async complete(request: AICompletionRequest): Promise<AICompletionResult> {
    const response = await withRetry(() =>
      this.client.messages.create({
        model: this.model,
        max_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
        messages: [{ role: 'user', content: request.prompt }],
      }),
    );

    const textBlock = response.content.find((block) => block.type === 'text');

    return {
      text: textBlock?.text ?? '',
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
    };
  }
}
