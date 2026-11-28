import { describe, expect, it } from "vitest";
import { joinUrl } from "../src/providers/http.js";

describe("joinUrl", () => {
  it("puts exactly one slash between the base URL and the path", () => {
    for (const base of ["https://api.example.com", "https://api.example.com/"]) {
      for (const path of ["v1/listen", "/v1/listen"]) {
        expect(joinUrl(base, path)).toBe("https://api.example.com/v1/listen");
      }
    }
  });

  it("drops repeated slashes at the join", () => {
    expect(joinUrl("http://localhost:8000/v1///", "///audio/transcriptions")).toBe("http://localhost:8000/v1/audio/transcriptions");
  });

  it("keeps a path in the base URL", () => {
    expect(joinUrl("https://proxy.example.com/stt/deepgram/", "v1/listen")).toBe("https://proxy.example.com/stt/deepgram/v1/listen");
  });

  it("leaves slashes inside the path alone", () => {
    expect(joinUrl("https://api.example.com", "v2/transcript//abc/")).toBe("https://api.example.com/v2/transcript//abc/");
  });
});
