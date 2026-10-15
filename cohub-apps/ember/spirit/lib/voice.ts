import type { CohubClient } from "@neta-art/cohub";
import { LIMITS, type Locale, VOICE } from "./mind.ts";

const PREFERRED_MODEL = "qwen-audio-3.0-tts-plus";

type Declaration = { model: string; hidden?: boolean; content?: { input?: Array<{ type?: string }> } };

export class Voice {
  private readonly client: CohubClient;
  private readonly spaceId: string;
  private readonly locale: Locale;
  private model: string | null = null;
  private reference: string | null = null;

  constructor(client: CohubClient, spaceId: string, locale: Locale) {
    this.client = client;
    this.spaceId = spaceId;
    this.locale = locale;
  }

  async prepare() {
    try {
      const { models } = await this.client.models.listMultimodal();
      const list = models as Declaration[];
      this.model = list.find((model) => model.model === PREFERRED_MODEL)?.model ?? list.find((model) => !model.hidden && /tts/i.test(model.model))?.model ?? null;
    } catch {
      this.model = null;
    }
    return this.model;
  }

  async speak(text: string): Promise<string | null> {
    if (!this.model || [...text].length < LIMITS.voiceMinChars) return null;
    const cloning = this.reference !== null && this.model === PREFERRED_MODEL;
    const result = await this.client.generations.createAndWait(
      {
        spaceId: this.spaceId,
        model: this.model,
        content: cloning
          ? [{ type: "text", text }, { type: "audio", source: { type: "url", url: this.reference as string } }]
          : [{ type: "text", text }],
        ...(cloning ? {} : { meta: { voice_prompt: VOICE[this.locale] } }),
      },
      { timeoutMs: 90_000 },
    );
    const url = result.output.find((block) => block.type === "audio" && block.source.type === "url");
    const audio = url && url.type === "audio" && url.source.type === "url" ? url.source.url : null;
    if (audio && !this.reference) this.reference = audio;
    return audio;
  }
}
