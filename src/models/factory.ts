import { ModelConfig } from "../types.js";
import { ModelClient } from "./modelClient.js";
import { PiAiClient } from "./piAiClient.js";

export function buildModelClient(config: ModelConfig): ModelClient {
  return new PiAiClient(config);
}
