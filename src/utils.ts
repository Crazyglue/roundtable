import { randomUUID } from "node:crypto";

export function nowIso(): string {
  return new Date().toISOString();
}

export function toJsonString(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export function makeId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

export function extractJsonObject(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error("Model response was empty.");
  }

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    const inner = fenced[1].trim();
    const fromFence = tryExtractBalancedJson(inner);
    if (fromFence) {
      return fromFence;
    }
  }

  const fromText = tryExtractBalancedJson(trimmed);
  if (fromText) {
    return fromText;
  }

  const repaired = tryRepairTruncatedJson(trimmed);
  if (repaired) {
    return repaired;
  }

  throw new Error("Model response did not contain parseable JSON object.");
}

function tryExtractBalancedJson(input: string): string | null {
  const starts: number[] = [];
  for (let i = 0; i < input.length; i += 1) {
    if (input[i] === "{") {
      starts.push(i);
    }
  }

  for (const start of starts) {
    let depth = 0;
    let inString = false;
    let escaping = false;

    for (let i = start; i < input.length; i += 1) {
      const ch = input[i];

      if (inString) {
        if (escaping) {
          escaping = false;
          continue;
        }
        if (ch === "\\") {
          escaping = true;
          continue;
        }
        if (ch === "\"") {
          inString = false;
        }
        continue;
      }

      if (ch === "\"") {
        inString = true;
        continue;
      }

      if (ch === "{") {
        depth += 1;
        continue;
      }

      if (ch === "}") {
        depth -= 1;
        if (depth === 0) {
          const candidate = input.slice(start, i + 1);
          try {
            JSON.parse(candidate);
            return candidate;
          } catch {
            break;
          }
        }
      }
    }
  }

  return null;
}

function tryRepairTruncatedJson(input: string): string | null {
  const start = input.indexOf("{");
  if (start === -1) {
    return null;
  }

  let candidate = input.slice(start);
  let depth = 0;
  let inString = false;
  let escaping = false;

  for (let i = 0; i < candidate.length; i += 1) {
    const ch = candidate[i];

    if (inString) {
      if (escaping) {
        escaping = false;
        continue;
      }
      if (ch === "\\") {
        escaping = true;
        continue;
      }
      if (ch === "\"") {
        inString = false;
      }
      continue;
    }

    if (ch === "\"") {
      inString = true;
      continue;
    }
    if (ch === "{") {
      depth += 1;
      continue;
    }
    if (ch === "}") {
      depth = Math.max(0, depth - 1);
    }
  }

  if (inString && escaping) {
    candidate += "\\";
  }
  if (inString) {
    candidate += "\"";
  }
  if (depth > 0) {
    candidate += "}".repeat(depth);
  }

  try {
    JSON.parse(candidate);
    return candidate;
  } catch {
    return null;
  }
}

export function clampText(input: string, maxChars: number): string {
  if (input.length <= maxChars) {
    return input;
  }
  return input.slice(input.length - maxChars);
}

export function sortByStableOrder(values: string[]): string[] {
  return [...values].sort((a, b) => a.localeCompare(b));
}
