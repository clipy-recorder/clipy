import { describe, expect, it } from "vitest";
import { ProviderError, joinUrl } from "../src/providers/http.js";

describe("ProviderError", () => {
  it("uses the API-key message for HTTP 401", () => {
    const error = new ProviderError("test-provider", 401);

    expect(error.message).toBe(
      "test-provider transcription failed (HTTP 401): check the API key",
    );
  });

  it("uses the API-key message for HTTP 403", () => {
    const error = new ProviderError("test-provider", 403);

    expect(error.message).toBe(
      "test-provider transcription failed (HTTP 403): check the API key",
    );
  });

  it("uses the audio-size message for HTTP 413", () => {
    const error = new ProviderError("test-provider", 413);

    expect(error.message).toBe(
      "test-provider transcription failed (HTTP 413): the audio is too large for this provider",
    );
  });

  it("uses the rate-limit message for HTTP 429", () => {
    const error = new ProviderError("test-provider", 429);

    expect(error.message).toBe(
      "test-provider transcription failed (HTTP 429): rate limited, try again later",
    );
  });

  it("includes the detail for other HTTP statuses", () => {
    const error = new ProviderError("test-provider", 500, "Internal server error");

    expect(error.message).toBe(
      "test-provider transcription failed (HTTP 500): Internal server error",
    );
  });

  it("does not include a supplied detail for HTTP 401", () => {
    const error = new ProviderError("test-provider", 401, "sensitive provider detail");

    expect(error.message).toBe(
      "test-provider transcription failed (HTTP 401): check the API key",
    );
    expect(error.message).not.toContain("sensitive provider detail");
  });

  it("uses the supplied detail when no HTTP status is available", () => {
    const error = new ProviderError("test-provider", undefined, "network error");

    expect(error.message).toBe(
      "test-provider transcription failed: network error",
    );
  });

  it("uses the default message when no status or detail is available", () => {
    const error = new ProviderError("test-provider");

    expect(error.message).toBe(
      "test-provider transcription failed: the provider could not be reached",
    );
  });
});

describe("joinUrl", () => {
  it("removes extra slashes from both sides of the URL boundary", () => {
    expect(joinUrl("https://example.com///", "///v1/transcribe")).toBe(
      "https://example.com/v1/transcribe",
    );
  });
});
