const RELAY_ATTACHMENT_CONTENT_PATH =
  /^\/relay\/v1\/nodes\/[A-Za-z0-9_-]{1,64}\/attachments\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/content$/;

export type RelayArtifactReplacement = {
  from: string;
  to: string;
};

export class RelayArtifactProjectionError extends Error {
  constructor(
    public readonly code:
      | "artifact_replacements_invalid"
      | "artifact_destination_invalid"
      | "artifact_target_missing",
    message: string,
  ) {
    super(message);
    this.name = "RelayArtifactProjectionError";
  }
}

type TurnProjection = {
  assistantContent: unknown;
  assistantText: string | null;
  summary: unknown;
};

function validateReplacements(replacements: RelayArtifactReplacement[]) {
  if (replacements.length === 0 || replacements.length > 20) {
    throw new RelayArtifactProjectionError(
      "artifact_replacements_invalid",
      "One to twenty returned artifact replacements are required",
    );
  }
  const bySource = new Map<string, string>();
  for (const replacement of replacements) {
    if (
      typeof replacement?.from !== "string" ||
      !replacement.from ||
      replacement.from.length > 2_048 ||
      /[\r\n]/.test(replacement.from)
    ) {
      throw new RelayArtifactProjectionError(
        "artifact_replacements_invalid",
        "A returned artifact source is invalid",
      );
    }
    if (!RELAY_ATTACHMENT_CONTENT_PATH.test(replacement.to)) {
      throw new RelayArtifactProjectionError(
        "artifact_destination_invalid",
        "A returned artifact destination is invalid",
      );
    }
    const existing = bySource.get(replacement.from);
    if (existing && existing !== replacement.to) {
      throw new RelayArtifactProjectionError(
        "artifact_replacements_invalid",
        "A returned artifact source has conflicting destinations",
      );
    }
    bySource.set(replacement.from, replacement.to);
  }
  return bySource;
}

function rewriteMarkdownTargets(
  value: unknown,
  replacements: Map<string, string>,
  matchedSources: Set<string>,
  matchedDestinations: Set<string>,
): unknown {
  if (typeof value === "string") {
    return value.replace(
      /\]\((?:<([^>\r\n]+)>|([^\s)\r\n]+))/g,
      (match, angleTarget: string | undefined, plainTarget: string | undefined) => {
        const target = angleTarget ?? plainTarget;
        if (!target) return match;
        const replacement = replacements.get(target);
        if (replacement) {
          matchedSources.add(target);
          return angleTarget ? `](<${replacement}>` : `](${replacement}`;
        }
        if ([...replacements.values()].includes(target)) {
          matchedDestinations.add(target);
        }
        return match;
      },
    );
  }
  if (Array.isArray(value)) {
    return value.map((item) =>
      rewriteMarkdownTargets(
        item,
        replacements,
        matchedSources,
        matchedDestinations,
      ),
    );
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        rewriteMarkdownTargets(
          item,
          replacements,
          matchedSources,
          matchedDestinations,
        ),
      ]),
    );
  }
  return value;
}

export function rewriteRelayArtifactProjection(
  projection: TurnProjection,
  replacements: RelayArtifactReplacement[],
): TurnProjection & { changed: boolean } {
  const replacementMap = validateReplacements(replacements);
  const matchedSources = new Set<string>();
  const matchedDestinations = new Set<string>();
  const source = {
    assistantContent: projection.assistantContent,
    assistantText: projection.assistantText,
    summary: projection.summary,
  };
  const rewritten = rewriteMarkdownTargets(
    source,
    replacementMap,
    matchedSources,
    matchedDestinations,
  ) as TurnProjection;

  for (const [from, to] of replacementMap) {
    if (!matchedSources.has(from) && !matchedDestinations.has(to)) {
      throw new RelayArtifactProjectionError(
        "artifact_target_missing",
        `Returned artifact target was not present: ${from}`,
      );
    }
  }

  return {
    ...rewritten,
    changed: matchedSources.size > 0,
  };
}
