import { describe, expect, it } from "vitest";
import { recognizerConfig } from "../src/local.js";

describe("recognizerConfig", () => {
  it("passes the selected language to the multilingual Whisper model", () => {
    const config = recognizerConfig("multilingual", "/models", 2, "hi") as {
      modelConfig: {
        whisper: {
          language: string;
          task: string;
        };
      };
    };

    expect(config.modelConfig.whisper.language).toBe("hi");
    expect(config.modelConfig.whisper.task).toBe("transcribe");
  });

  it("keeps automatic language detection when no language is selected", () => {
    const config = recognizerConfig("multilingual", "/models", 2) as {
      modelConfig: {
        whisper: {
          language: string;
        };
      };
    };

    expect(config.modelConfig.whisper.language).toBe("");
  });
});