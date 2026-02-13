import {
  complete,
  type Api,
  type AssistantMessage,
  type Context,
  type Message,
  type Model
} from "@mariozechner/pi-ai";
import { resolveModelCredential } from "../auth/credentials.js";
import { ModelConfig } from "../types.js";
import { ChatMessage, CompletionOptions, ModelClient } from "./modelClient.js";

function resolveApi(config: ModelConfig): Api {
  if (config.api) {
    return config.api as Api;
  }

  if (config.provider === "anthropic") {
    return "anthropic-messages";
  }

  if (config.provider === "openai-codex") {
    return "openai-codex-responses";
  }

  return "openai-completions";
}

function defaultBaseUrlFor(api: Api): string {
  if (api === "anthropic-messages") {
    return "https://api.anthropic.com";
  }
  if (api === "openai-codex-responses") {
    return "https://chatgpt.com/backend-api";
  }
  return "https://api.openai.com/v1";
}

function buildModel(config: ModelConfig): Model<Api> {
  const api = resolveApi(config);
  const maxTokens = config.maxTokens ?? 1200;
  const provider = config.provider;
  const model: Model<Api> = {
    id: config.model,
    name: config.model,
    api,
    provider,
    baseUrl: config.baseUrl ?? defaultBaseUrlFor(api),
    reasoning: true,
    input: ["text"],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 200_000,
    maxTokens,
    headers: config.headers
  };
  return model;
}

function toPiAiContext(messages: ChatMessage[], model: Model<Api>): Context {
  const systemParts = messages
    .filter((message) => message.role === "system")
    .map((message) => message.content.trim())
    .filter(Boolean);

  const now = Date.now();
  const piMessages: Message[] = [];
  let offset = 0;
  for (const message of messages) {
    if (message.role === "system") {
      continue;
    }

    if (message.role === "user") {
      piMessages.push({
        role: "user",
        content: message.content,
        timestamp: now + offset
      });
      offset += 1;
      continue;
    }

    const assistant: AssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: message.content }],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0
        }
      },
      stopReason: "stop",
      timestamp: now + offset
    };
    piMessages.push(assistant);
    offset += 1;
  }

  return {
    systemPrompt: systemParts.length > 0 ? systemParts.join("\n\n") : undefined,
    messages: piMessages
  };
}

function extractResponseText(message: AssistantMessage): string {
  const text = message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("")
    .trim();
  if (text) {
    return text;
  }

  const thinking = message.content
    .filter((part) => part.type === "thinking")
    .map((part) => part.thinking)
    .join("")
    .trim();
  if (thinking) {
    return thinking;
  }

  const toolCalls = message.content
    .filter((part) => part.type === "toolCall")
    .map((part) => ({
      id: part.id,
      name: part.name,
      arguments: part.arguments
    }));
  if (toolCalls.length > 0) {
    return JSON.stringify(toolCalls);
  }

  throw new Error("pi-ai response did not contain text/thinking/tool-call content.");
}

export class PiAiClient implements ModelClient {
  private readonly config: ModelConfig;
  private readonly model: Model<Api>;
  private readonly defaultTemperature?: number;
  private readonly defaultMaxTokens?: number;

  constructor(config: ModelConfig) {
    this.config = config;
    this.model = buildModel(config);
    this.defaultTemperature = config.temperature;
    this.defaultMaxTokens = config.maxTokens;
  }

  async completeText(messages: ChatMessage[], options?: CompletionOptions): Promise<string> {
    const apiKey = await resolveModelCredential(this.config);
    const context = toPiAiContext(messages, this.model);
    const response = await complete(this.model, context, {
      apiKey,
      temperature: options?.temperature ?? this.defaultTemperature,
      maxTokens: options?.maxTokens ?? this.defaultMaxTokens,
      headers: this.config.headers
    });
    return extractResponseText(response);
  }
}
