import { extractJsonObject } from "../utils.js";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface CompletionOptions {
  temperature?: number;
  maxTokens?: number;
}

export interface ModelClient {
  completeText(messages: ChatMessage[], options?: CompletionOptions): Promise<string>;
}

export async function completeJson<T>(
  client: ModelClient,
  messages: ChatMessage[],
  options?: CompletionOptions
): Promise<T> {
  const text = await client.completeText(messages, options);
  const json = extractJsonObject(text);
  return JSON.parse(json) as T;
}
