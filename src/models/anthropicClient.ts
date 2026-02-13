import { ChatMessage, CompletionOptions, ModelClient } from "./modelClient.js";
import { ModelConfig } from "../types.js";
import Anthropic from "@anthropic-ai/sdk";

export class AnthropicClient implements ModelClient {
  private readonly client: Anthropic;
  private readonly model: string;
  private readonly defaultTemperature?: number;
  private readonly defaultMaxTokens?: number;

  constructor(config: ModelConfig) {
    const apiKey = process.env[config.apiKeyEnv] ?? "";
    if (!apiKey) {
      throw new Error(`Missing API key env var: ${config.apiKeyEnv}`);
    }

    this.client = new Anthropic({
      apiKey,
      baseURL: config.baseUrl,
      defaultHeaders: config.headers
    });
    this.model = config.model;
    this.defaultTemperature = config.temperature;
    this.defaultMaxTokens = config.maxTokens ?? 1200;
  }

  async completeText(messages: ChatMessage[], options?: CompletionOptions): Promise<string> {
    const systemParts = messages.filter((m) => m.role === "system").map((m) => m.content.trim());
    const userAssistantMessages = messages.filter(
      (m): m is ChatMessage & { role: "user" | "assistant" } =>
        m.role === "user" || m.role === "assistant"
    );

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: options?.maxTokens ?? this.defaultMaxTokens ?? 1200,
      temperature: options?.temperature ?? this.defaultTemperature,
      system: systemParts.length > 0 ? systemParts.join("\n\n") : undefined,
      messages: userAssistantMessages.map((message) => ({
        role: message.role,
        content: message.content
      }))
    });

    const content = (response.content ?? [])
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
