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
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first === -1 || last === -1 || last <= first) {
    throw new Error("Model response did not contain a JSON object.");
  }
  return text.slice(first, last + 1);
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
