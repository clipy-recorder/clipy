import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { chatJSON, runWithModelProvider, stripCodeFence, type ModelProvider } from "../src/llm.js";

let server: Server | null = null;

afterEach(() => {
  server?.close();
  server = null;
});

function fakeServer(handler: (req: any, res: any) => void): Promise<{ url: string; server: Server }> {
  return new Promise((resolve) => {
    const s = createServer(handler);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as AddressInfo).port;
      server = s;
      resolve({ url: `http://127.0.0.1:${port}`, server: s });
    });
  });
}

describe("stripCodeFence (Issue #34)", () => {
  it("strips fences and handles surrounding prose like Rust implementation", () => {
    expect(stripCodeFence("```json\n{\"a\":1}\n```")).toBe("{\"a\":1}");
    expect(stripCodeFence("  ```JSON {} ```  ")).toBe("{}");
    expect(stripCodeFence("```\n[]\n```")).toBe("[]");
    expect(stripCodeFence("{}")).toBe("{}");
    expect(stripCodeFence("```{}")).toBe("```{}");
    expect(stripCodeFence("``````")).toBe("");
    expect(stripCodeFence("Here are the moments:\n```json\n{\"a\":1}\n```")).toBe("{\"a\":1}");
    expect(stripCodeFence("Here are the moments:\n```\n[]\n```\nDone!")).toBe("[]");
  });
});

describe("chatJSON with LM Studio / 400 fallback (Issue #39)", () => {
  it("retries without response_format when server rejects it with 400", async () => {
    const receivedBodies: any[] = [];
    const { url } = await fakeServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      const parsed = JSON.parse(body);
      receivedBodies.push(parsed);

      if (parsed.response_format) {
        // Simulates LM Studio or local OpenAI server rejecting json_object with 400
        res.statusCode = 400;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: { message: "response_format 'json_object' not supported" } }));
      } else {
        // Succeeds on retry without response_format
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: "Here are the moments:\n```json\n{\"moments\":[{\"timestamp_ms\":1000,\"reason\":\"test\"}]}\n```",
                },
              },
            ],
          }),
        );
      }
    });

    const provider: ModelProvider = {
      baseUrl: `${url}/v1`,
      model: "test-model",
      apiKey: "",
    };

    const { result } = await runWithModelProvider(provider, () =>
      chatJSON<{ moments: Array<{ timestamp_ms: number; reason: string }> }>({
        messages: [{ role: "user", content: "plan moments" }],
      }),
    );

    expect(receivedBodies).toHaveLength(2);
    expect(receivedBodies[0].response_format).toEqual({ type: "json_object" });
    expect(receivedBodies[1].response_format).toBeUndefined();
    expect(result.parsed.moments).toHaveLength(1);
    expect(result.parsed.moments[0]).toEqual({ timestamp_ms: 1000, reason: "test" });
  });
});
