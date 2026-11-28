import { createServer, type IncomingHttpHeaders, type RequestListener, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  chatJSON,
  LLMError,
  MODEL_ERROR,
  withModelProvider,
  type ChatOptions,
  type ModelProvider,
} from "../src/llm.js";

const servers: Server[] = [];

afterEach(() => {
  for (const s of servers.splice(0)) {
    s.close();
  }
});

async function createMockServer(handler: RequestListener): Promise<{ baseUrl: string }> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}/v1` };
}

const defaultOpts: ChatOptions = {
  messages: [{ role: "user", content: "summarize moments" }],
};

describe("chatJSON", () => {
  it("returns empty moments without network when no provider is configured", async () => {
    const result = await chatJSON(defaultOpts);
    expect(result).toEqual({ parsed: { moments: [] }, raw: { text: "" } });
  });

  it("returns empty moments when provider is null in withModelProvider", async () => {
    const result = await withModelProvider(null, () => chatJSON(defaultOpts));
    expect(result).toEqual({ parsed: { moments: [] }, raw: { text: "" } });
  });

  it("drops a trailing slash on baseUrl", async () => {
    let requestedUrl = "";
    const server = await createMockServer((req, res) => {
      requestedUrl = req.url ?? "";
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }));
    });

    const provider: ModelProvider = {
      baseUrl: `${server.baseUrl}/`,
      model: "test-model",
    };
    const result = await withModelProvider(provider, () => chatJSON(defaultOpts));
    expect(result.parsed).toEqual({ ok: true });
    expect(requestedUrl).toBe("/v1/chat/completions");
  });

  it("drops multiple trailing slashes on baseUrl", async () => {
    let requestedUrl = "";
    const server = await createMockServer((req, res) => {
      requestedUrl = req.url ?? "";
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }));
    });

    const provider: ModelProvider = {
      baseUrl: `${server.baseUrl}///`,
      model: "test-model",
    };
    const result = await withModelProvider(provider, () => chatJSON(defaultOpts));
    expect(result.parsed).toEqual({ ok: true });
    expect(requestedUrl).toBe("/v1/chat/completions");
  });

  it("sends no Authorization header without a key", async () => {
    let authHeader: string | undefined = "sentinel";
    const server = await createMockServer((req, res) => {
      authHeader = req.headers.authorization;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }));
    });

    const provider: ModelProvider = {
      baseUrl: server.baseUrl,
      model: "test-model",
    };
    await withModelProvider(provider, () => chatJSON(defaultOpts));
    expect(authHeader).toBeUndefined();
  });

  it("sends an Authorization header when a key is provided", async () => {
    let authHeader: string | undefined;
    const server = await createMockServer((req, res) => {
      authHeader = req.headers.authorization;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }));
    });

    const provider: ModelProvider = {
      baseUrl: server.baseUrl,
      apiKey: "sk-test-secret-key",
      model: "test-model",
    };
    await withModelProvider(provider, () => chatJSON(defaultOpts));
    expect(authHeader).toBe("Bearer sk-test-secret-key");
  });

  it("sends provider headers", async () => {
    let receivedHeaders: IncomingHttpHeaders = {};
    const server = await createMockServer((req, res) => {
      receivedHeaders = req.headers;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }));
    });

    const provider: ModelProvider = {
      baseUrl: server.baseUrl,
      model: "test-model",
      headers: {
        "HTTP-Referer": "https://clipy.online",
        "X-Title": "Clipy Moments Test",
      },
    };
    await withModelProvider(provider, () => chatJSON(defaultOpts));
    expect(receivedHeaders["http-referer"]).toBe("https://clipy.online");
    expect(receivedHeaders["x-title"]).toBe("Clipy Moments Test");
  });

  it("parses a reply in a ```json code fence", async () => {
    const server = await createMockServer((_req, res) => {
      res.setHeader("Content-Type", "application/json");
      const fenced = '```json\n{"moments": [{"time_ms": 1500, "label": "save clicked"}]}\n```';
      res.end(JSON.stringify({ choices: [{ message: { content: fenced } }] }));
    });

    const provider: ModelProvider = { baseUrl: server.baseUrl, model: "test-model" };
    const result = await withModelProvider(provider, () =>
      chatJSON<{ moments: Array<{ time_ms: number; label: string }> }>(defaultOpts),
    );
    expect(result.parsed).toEqual({
      moments: [{ time_ms: 1500, label: "save clicked" }],
    });
    expect(result.raw.text).toContain("```json");
  });

  it("parses a reply in a generic ``` code fence", async () => {
    const server = await createMockServer((_req, res) => {
      res.setHeader("Content-Type", "application/json");
      const fenced = '```\n{"moments": []}\n```';
      res.end(JSON.stringify({ choices: [{ message: { content: fenced } }] }));
    });

    const provider: ModelProvider = { baseUrl: server.baseUrl, model: "test-model" };
    const result = await withModelProvider(provider, () => chatJSON(defaultOpts));
    expect(result.parsed).toEqual({ moments: [] });
  });

  it.each([
    { status: 400, expectedTransient: false },
    { status: 401, expectedTransient: false },
    { status: 408, expectedTransient: true },
    { status: 429, expectedTransient: true },
    { status: 503, expectedTransient: true },
  ])(
    "HTTP $status gives LLMError with transient: $expectedTransient",
    async ({ status, expectedTransient }) => {
      const server = await createMockServer((_req, res) => {
        res.statusCode = status;
        res.end(JSON.stringify({ error: `Failure status ${status}` }));
      });

      const provider: ModelProvider = { baseUrl: server.baseUrl, model: "test-model" };
      let caught: unknown;
      try {
        await withModelProvider(provider, () => chatJSON(defaultOpts));
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(LLMError);
      const llmErr = caught as LLMError;
      expect(llmErr.upstreamStatus).toBe(status);
      expect(llmErr.transient).toBe(expectedTransient);
      expect(llmErr.message).toBe(`Model provider returned HTTP ${status}`);
    },
  );

  it("refuses a 302 redirect rather than following it", async () => {
    let followedRedirect = false;
    const server = await createMockServer((req, res) => {
      if (req.url === "/v1/redirected") {
        followedRedirect = true;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }));
        return;
      }
      res.writeHead(302, { Location: "/v1/redirected" });
      res.end();
    });

    const provider: ModelProvider = { baseUrl: server.baseUrl, model: "test-model" };
    await expect(withModelProvider(provider, () => chatJSON(defaultOpts))).rejects.toThrow();
    expect(followedRedirect).toBe(false);
  });

  it("throws no-completion error when choices is empty", async () => {
    const server = await createMockServer((_req, res) => {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ choices: [] }));
    });

    const provider: ModelProvider = { baseUrl: server.baseUrl, model: "test-model" };
    let caught: unknown;
    try {
      await withModelProvider(provider, () => chatJSON(defaultOpts));
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(LLMError);
    const llmErr = caught as LLMError;
    expect(llmErr.message).toBe(MODEL_ERROR.noCompletion);
    expect(llmErr.transient).toBe(true);
    expect(llmErr.upstreamStatus).toBe(200);
  });

  it("throws no-completion error when choices[0].message.content is null", async () => {
    const server = await createMockServer((_req, res) => {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content: null } }] }));
    });

    const provider: ModelProvider = { baseUrl: server.baseUrl, model: "test-model" };
    await expect(withModelProvider(provider, () => chatJSON(defaultOpts))).rejects.toThrow(
      MODEL_ERROR.noCompletion,
    );
  });

  it("throws unparseable error on invalid JSON completion", async () => {
    const server = await createMockServer((_req, res) => {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content: "not valid json {" } }] }));
    });

    const provider: ModelProvider = { baseUrl: server.baseUrl, model: "test-model" };
    let caught: unknown;
    try {
      await withModelProvider(provider, () => chatJSON(defaultOpts));
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(LLMError);
    const llmErr = caught as LLMError;
    expect(llmErr.message).toBe(MODEL_ERROR.unparseable);
    expect(llmErr.transient).toBe(true);
    expect(llmErr.upstreamStatus).toBe(200);
  });
});
