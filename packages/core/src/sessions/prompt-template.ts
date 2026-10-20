export type PromptTemplateContext = {
  sessionId?: string | null;
  spaceId?: string | null;
  userUuid?: string | null;
};

export type PromptCommand = {
  name: string;
  argsText: string;
  args: string[];
};

type PromptArgs = Pick<PromptCommand, "args" | "argsText">;

const SYSTEM_VARIABLE_PATTERN = /\{\{\s*(cohub\.(?:session|space)\.id|cohub\.user\.uuid)\s*\}\}/g;
const ARGUMENT_PATTERN = /\$(?:(\d+)|\{@:(\d+)(?::(\d+))?\}|ARGUMENTS|@)/g;

function substituteSystemVariables(content: string, context: PromptTemplateContext): string {
  const values: Record<string, string | null | undefined> = {
    "cohub.session.id": context.sessionId,
    "cohub.space.id": context.spaceId,
    "cohub.user.uuid": context.userUuid,
  };

  return content.replace(SYSTEM_VARIABLE_PATTERN, (match, name: string) => values[name] || match);
}

function splitPromptArgs(argsText: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: string | null = null;

  for (const char of argsText) {
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (/\s/.test(char)) {
      if (current) args.push(current);
      current = "";
    } else {
      current += char;
    }
  }

  if (current) args.push(current);
  return args;
}

export function parsePromptCommand(text: string): PromptCommand | null {
  const [, name, argsText = ""] = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text) ?? [];
  return name ? { name, argsText, args: splitPromptArgs(argsText) } : null;
}

function substituteArgs(content: string, { args, argsText }: PromptArgs): string {
  return content.replace(ARGUMENT_PATTERN, (_, index?: string, start?: string, length?: string) => {
    if (index) return args[Number.parseInt(index, 10) - 1] ?? "";
    if (!start) return argsText;
    const from = Math.max(Number.parseInt(start, 10) - 1, 0);
    return args.slice(from, length ? from + Number.parseInt(length, 10) : undefined).join(" ");
  });
}

export function renderPromptTemplate(content: string, args: PromptArgs, context: PromptTemplateContext = {}): string {
  return substituteArgs(substituteSystemVariables(content, context), args);
}
