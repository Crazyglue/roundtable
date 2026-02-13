import { ChatMessage, CompletionOptions, ModelClient } from "./modelClient.js";
import { ModelConfig } from "../types.js";

interface AnthropicResponse {
  content?: Array<{ type: string; text?: string }>;
}

export class AnthropicClient implements ModelClient {
  private readonly endpoint: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly defaultTemperature?: number;
  private readonly defaultMaxTokens?: number;
  private readonly headers: Record<string, string>;

  constructor(config: ModelConfig) {
    this.endpoint = `${(config.baseUrl ?? "https://api.anthropic.com").replace(/\/$/, "")}/v1/messages`;
    this.apiKey = process.env[config.apiKeyEnv] ?? "";
    this.model = config.model;
    this.defaultTemperature = config.temperature;
    this.defaultMaxTokens = config.maxTokens ?? 1200;
    this.headers = config.headers ?? {};
    if (!this.apiKey) {
      throw new Error(`Missing API key env var: ${config.apiKeyEnv}`);
    }
  }

  async completeText(messages: ChatMessage[], options?: CompletionOptions): Promise<string> {
    const systemParts = messages.filter((m) => m.role === "system").map((m) => m.content.trim());
    const userAssistantMessages = messages
      .filter((m) => m.role !== "system")
      .map((m) => ({ role: m.role, content: m.content }));

    const res = await fetch(this.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
        ...this.headers
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: options?.maxTokens ?? this.defaultMaxTokens,
        temperature: options?.temperature ?? this.defaultTemperature,
        system: systemParts.join("\n\n"),
        messages: userAssistantMessages
      })
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Anthropic request failed (${res.status}): ${body}`);
    }

    const payload = (await res.json()) as AnthropicResponse;
    const content = (payload.content ?? [])
      .filter((part) => part.type === "text" && part.text)
      .map((part) => part.text ?? "")
      .join("")
      .trim();

    if (!content) {
      throw new Error("Anthropic response contained empty content.");
    }
    return content;
  }
}
