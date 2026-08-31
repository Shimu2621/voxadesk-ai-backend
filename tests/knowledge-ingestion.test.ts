import { describe, expect, it } from "vitest";
import { FakeKnowledgeIngestionProvider } from "../src/integrations/knowledge-ingestion.js";

describe("knowledge ingestion adapter", () => {
  it("extracts text, URL, and document fixtures", async () => {
    const provider = new FakeKnowledgeIngestionProvider();
    await expect(
      provider.extract({
        type: "TEXT",
        name: "Text",
        contentText: "safe fixture",
      }),
    ).resolves.toMatchObject({
      success: true,
      data: { content: "safe fixture" },
    });
    await expect(
      provider.extract({
        type: "URL",
        name: "Site",
        sourceUrl: "https://example.test/docs",
      }),
    ).resolves.toMatchObject({ success: true });
    await expect(
      provider.extract({
        type: "PDF",
        name: "Guide",
        storageKey: "org/fake.pdf",
        mimeType: "application/pdf",
      }),
    ).resolves.toMatchObject({ success: true });
  });

  it("supports deterministic provider failure and retry", async () => {
    const input = { type: "PDF", name: "Guide", storageKey: "org/fake.pdf" };
    await expect(
      new FakeKnowledgeIngestionProvider(true).extract(input),
    ).resolves.toMatchObject({ success: false, code: "REJECTED" });
    await expect(
      new FakeKnowledgeIngestionProvider().extract(input),
    ).resolves.toMatchObject({ success: true });
  });

  it("confirms fake provider deletion before lifecycle removal", async () => {
    await expect(
      new FakeKnowledgeIngestionProvider().remove({
        storageKey: "org/fake.pdf",
      }),
    ).resolves.toEqual({ success: true, data: { removed: true } });
    await expect(
      new FakeKnowledgeIngestionProvider(true).remove({
        storageKey: "org/fake.pdf",
      }),
    ).resolves.toMatchObject({ success: false });
  });
});
