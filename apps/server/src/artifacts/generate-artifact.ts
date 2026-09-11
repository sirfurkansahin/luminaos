import type { AIProvider, AITokenUsage } from '@luminaos/ai-gateway';
import { artifactContentSchema, renderArtifactHtml } from '@luminaos/artifacts';
import type { ArtifactContent, ArtifactType, ThemePresetName } from '@luminaos/artifacts';

/**
 * The provider-facing, DB-free "turn a natural-language prompt into rendered
 * artifact HTML" orchestrator (F3-T7 PR2, ADR-0041 Karar a/c): sibling of
 * `parseCommand` (`../ai/parse-command.ts`)/`resolveAIFieldValue`
 * (`../ai/resolve-ai-field-value.ts`) -- provider/model/recordUsage all
 * injected, no Postgres/EventStore.
 *
 * Per ADR-0041 Karar (c), the model NEVER produces raw HTML/CSS/JS -- only
 * structured `ArtifactContent` (title + typed sections), validated by
 * `@luminaos/artifacts`'s `artifactContentSchema`, then wrapped by the REAL
 * `renderArtifactHtml` into the final self-contained HTML string.
 */
export interface GenerateArtifactInput {
  provider: AIProvider;
  prompt: string;
  artifactType: ArtifactType;
  themePreset: ThemePresetName;
  model?: string;
  recordUsage: (usage: AITokenUsage) => Promise<void> | void;
}

export interface GenerateArtifactResult {
  htmlContent: string;
  parseError: boolean;
  message?: string;
}

/** ADR-0041 Karar (b): write-time size cap on the rendered `htmlContent`,
 * enforced HERE (not in the shared field-type registry) -- see this repo's
 * ADR for the full rationale. */
export const MAX_ARTIFACT_HTML_LENGTH = 200_000;

const GENERATE_EXHAUSTED_MESSAGE =
  'AI response could not be parsed into valid artifact content after retry';

const OVERSIZED_MESSAGE = 'Generated artifact exceeded the maximum allowed size';

function renderContentPrompt(prompt: string, artifactType: ArtifactType): string {
  return [
    `Generate the CONTENT for a "${artifactType}" based on the request below.`,
    'Respond with ONLY a JSON object (no surrounding text, no markdown fences) with exactly these fields:',
    "- title: a short string, the artifact's title",
    '- sections: an array of section objects, each with a "kind" field ("heading"|"paragraph"|"list"|"table"|"imagePlaceholder") plus kind-specific fields',
    'Do NOT include any HTML, CSS, or JavaScript -- structured content only, the presentation layer is applied separately.',
    '',
    `Request: ${prompt}`,
  ].join('\n');
}

function tryParseContent(text: string): ArtifactContent | undefined {
  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }

  const result = artifactContentSchema.safeParse(parsed);

  // `exactOptionalPropertyTypes`-safe cast: zod's inferred output type marks
  // every optional `ArtifactSection` field as `T | undefined` (a key that is
  // always present, just possibly `undefined`), which is structurally
  // stricter than -- and therefore not directly assignable to --
  // `ArtifactContent`'s own hand-written `key?: T` (a key that may be
  // entirely absent). The validated data genuinely conforms to
  // `ArtifactContent` at runtime; this cast only reconciles the two
  // type-level shapes.
  return result.success ? (result.data as ArtifactContent) : undefined;
}

export async function generateArtifact(
  input: GenerateArtifactInput,
): Promise<GenerateArtifactResult> {
  const prompt = renderContentPrompt(input.prompt, input.artifactType);

  const complete = async (): Promise<string> => {
    const result = await input.provider.complete({
      prompt,
      ...(input.model !== undefined ? { model: input.model } : {}),
    });
    await input.recordUsage(result.usage);
    return result.text;
  };

  const firstResponse = await complete();
  const firstContent = tryParseContent(firstResponse);

  const content = firstContent ?? tryParseContent(await complete());

  if (content === undefined) {
    return { htmlContent: '', parseError: true, message: GENERATE_EXHAUSTED_MESSAGE };
  }

  const htmlContent = renderArtifactHtml(content, input.themePreset, input.artifactType);

  if (htmlContent.length > MAX_ARTIFACT_HTML_LENGTH) {
    return { htmlContent: '', parseError: true, message: OVERSIZED_MESSAGE };
  }

  return { htmlContent, parseError: false };
}
