import type { ProviderResult } from "./providers.js";

export type KnowledgeInput = {
  type: string;
  name: string;
  contentText?: string | null;
  sourceUrl?: string | null;
  storageKey?: string | null;
  mimeType?: string | null;
  sizeBytes?: number | null;
};

export interface KnowledgeIngestionProvider {
  extract(input: KnowledgeInput): Promise<ProviderResult<{ content: string }>>;
  remove(input: {
    storageKey?: string | null;
  }): Promise<ProviderResult<{ removed: true }>>;
}

export class FakeKnowledgeIngestionProvider implements KnowledgeIngestionProvider {
  constructor(private readonly fail = false) {}

  async extract(
    input: KnowledgeInput,
  ): Promise<ProviderResult<{ content: string }>> {
    if (this.fail)
      return {
        success: false,
        code: "REJECTED",
        message: "Fake extraction failure.",
      };
    if (input.type === "TEXT" || (input.type === "TXT" && input.contentText))
      return { success: true, data: { content: input.contentText ?? "" } };
    if (input.type === "URL" && input.sourceUrl)
      return {
        success: true,
        data: { content: `Fake indexed content from ${input.sourceUrl}` },
      };
    if (input.storageKey)
      return {
        success: true,
        data: {
          content: `Fake extracted ${input.name} (${input.mimeType ?? "document"})`,
        },
      };
    return {
      success: false,
      code: "REJECTED",
      message: "Knowledge source has no extractable content.",
    };
  }

  async remove(_input: {
    storageKey?: string | null;
  }): Promise<ProviderResult<{ removed: true }>> {
    if (this.fail)
      return {
        success: false,
        code: "REJECTED",
        message: "Fake deletion failure.",
      };
    return { success: true, data: { removed: true } };
  }
}
