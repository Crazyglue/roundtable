import { ModelConfig } from "../types.js";
import { ModelClient } from "./modelClient.js";
import { OpenAICompatibleClient } from "./openaiCompatibleClient.js";
import { AnthropicClient } from "./anthropicClient.js";

export function buildModelClient(config: ModelConfig): ModelClient {
  if (config.provider === "openai-compatible" || config.provider === "openai") {
    return new OpenAICompatibleClient(config);
  }
  if (config.provider === "anthropic") {
    return new AnthropicClient(config);
  }
  const exhaustive: never = config.provider;
  throw new Error(`Unsupported provider: ${exhaustive}`);
}
