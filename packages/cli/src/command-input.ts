import { error } from "./output.js";

export function collectOption(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

export async function readPromptContent(words: string[], options: { allowEmpty?: boolean } = {}): Promise<string> {
  let content = words.join(" ");
  if (!content && !process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    content = Buffer.concat(chunks).toString().trim();
  }
  if (!content && !options.allowEmpty) return error("No content", "Pass as argument or pipe via stdin");
  return content;
}
