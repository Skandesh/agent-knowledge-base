import { createHash } from "node:crypto";

export function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export function stableId(prefix: string, input: string): string {
  return `${prefix}_${sha256(input).slice(0, 18)}`;
}
