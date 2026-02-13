import { ChatMessage, CompletionOptions, ModelClient } from "./modelClient.js";
import { ModelConfig } from "../types.js";
import OpenAI from "openai";

function resolveContent(content: string | Array<{ type: string; text?: string }> | undefined): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => (part.type === "text" ? part.text ?? "" : ""))
      .join("")
      .trim();
  }
  return "";
}

export class OpenAICompatibleClient implements ModelClient {
  private readonly client: OpenAI;
  private readonly model: string;
  private readonly defaultTemperature?: number;
  private readonly defaultMaxTokens?: number;

  constructor(config: ModelConfig) {
    const apiKey = process.env[config.apiKeyEnv] ?? "";
    if (!apiKey) {
      throw new Error(`Missing API key env var: ${config.apiKeyEnv}`);
    }

    this.client = new OpenAI({
      apiKey,
      baseURL: config.baseUrl,
      defaultHeaders: config.headers
    });
    this.model = config.model;
    this.defaultTemperature = config.temperature;
    this.defaultMaxTokens = config.maxTokens;
  }

  async completeText(messages: ChatMessage[], options?: CompletionOptions): Promise<string> {
    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: messages.map((message) => ({
        role: message.role,
        content: message.content
      })),
      temperature: options?.temperature ?? this.defaultTemperature,
      max_tokens: options?.maxTokens ?? this.defaultMaxTokens
    });

    const content = resolveContent(response.choices?.[0]?.message?.content);
    if (!content) {
      throw new Error("OpenAI-compatible response contained empty content.");
    }
    return content;
  }
}
