import { ChatMessage, CompletionOptions, ModelClient } from "./modelClient.js";
import { ModelConfig } from "../types.js";

interface OpenAIChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string | Array<{ type: string; text?: string }>;
    };
  }>;
}

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
  private readonly endpoint: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly defaultTemperature?: number;
  private readonly defaultMaxTokens?: number;
  private readonly headers: Record<string, string>;

  constructor(config: ModelConfig) {
    this.endpoint = `${(config.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "")}/chat/completions`;
    this.model = config.model;
    this.defaultTemperature = config.temperature;
    this.defaultMaxTokens = config.maxTokens;
    this.headers = config.headers ?? {};
    this.apiKey = process.env[config.apiKeyEnv] ?? "";
    if (!this.apiKey) {
      throw new Error(`Missing API key env var: ${config.apiKeyEnv}`);
    }
  }

  async completeText(messages: ChatMessage[], options?: CompletionOptions): Promise<string> {
    const res = await fetch(this.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
        ...this.headers
      },
      body: JSON.stringify({
        model: this.model,
        messages,
        temperature: options?.temperature ?? this.defaultTemperature,
        max_tokens: options?.maxTokens ?? this.defaultMaxTokens
      })
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`OpenAI-compatible request failed (${res.status}): ${body}`);
    }

    const payload = (await res.json()) as OpenAIChatCompletionResponse;
    const content = resolveContent(payload.choices?.[0]?.message?.content);
    if (!content) {
      throw new Error("OpenAI-compatible response contained empty content.");
    }
    return content;
  }
}
