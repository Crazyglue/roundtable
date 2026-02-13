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

export class JsonResponseParseError extends Error {
  readonly rawResponse: string;

  constructor(message: string, rawResponse: string) {
    super(message);
    this.name = "JsonResponseParseError";
    this.rawResponse = rawResponse;
  }
}

export async function completeJson<T>(
  client: ModelClient,
  messages: ChatMessage[],
  options?: CompletionOptions
): Promise<T> {
  const text = await client.completeText(messages, options);
  try {
    const json = extractJsonObject(text);
    return JSON.parse(json) as T;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new JsonResponseParseError(
      `Failed to parse model JSON response: ${message}`,
      text
    );
  }
}
