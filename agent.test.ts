import assert from "node:assert/strict";
import test from "node:test";
import agent, { classify, chooseModel } from "./agent.ts";

const MODELS = [
  { id: "qwen/qwen3.7-flash", category: "text", input_modalities: ["text", "image", "video"], output_modalities: ["text"], pricing: { promptTextTokens: "0.00000003165", completionTextTokens: "0.00000013715" } },
  { id: "inception/mercury-2.5-preview", category: "text", input_modalities: ["text"], output_modalities: ["text"], pricing: { promptTextTokens: "0.0000000422", completionTextTokens: "0.00000015825" } },
  { id: "openai/gpt-5.4-nano", category: "text", input_modalities: ["text", "image"], output_modalities: ["text"], pricing: { promptTextTokens: "0.00000015", completionTextTokens: "0.0000009375" } },
  { id: "z-ai/glm-5.3-flash", category: "text", input_modalities: ["text", "image"], output_modalities: ["text"], pricing: { promptTextTokens: "0.00000015", completionTextTokens: "0.0000005" } },
  { id: "openai/gpt-5.4-mini", category: "text", input_modalities: ["text", "image"], output_modalities: ["text"], pricing: { promptTextTokens: "0.0000005625", completionTextTokens: "0.000003375" } },
  { id: "google/gemini-3.8-flash", category: "text", input_modalities: ["text", "image", "audio", "video"], output_modalities: ["text"], pricing: { promptTextTokens: "0.00000079125", completionTextTokens: "0.00000395625" } },
  { id: "qwen/qwen3.7-plus", category: "text", input_modalities: ["text", "image"], output_modalities: ["text"], pricing: { promptTextTokens: "0.0000003376", completionTextTokens: "0.0000013504" } },
  { id: "amazon/nova-2-lite-v1", category: "text", input_modalities: ["text", "image"], output_modalities: ["text"], pricing: { promptTextTokens: "0.00000033", completionTextTokens: "0.00000275" } },
  { id: "openai/gpt-5.4", category: "text", input_modalities: ["text", "image"], output_modalities: ["text"], pricing: { promptTextTokens: "0.000001875", completionTextTokens: "0.00001125" } },
  { id: "x-ai/grok-4.3", category: "text", input_modalities: ["text", "image"], output_modalities: ["text"], pricing: { promptTextTokens: "0.0000009375", completionTextTokens: "0.000001875" } },
  { id: "z-ai/glm-5.3", category: "text", input_modalities: ["text"], output_modalities: ["text"], pricing: { promptTextTokens: "0.0000014", completionTextTokens: "0.0000044" } },
  { id: "anthropic/claude-sonnet-4.6", category: "text", input_modalities: ["text", "image"], output_modalities: ["text"], pricing: { promptTextTokens: "0.000003", completionTextTokens: "0.000015" } },
];

function statusRows(overrides: Record<string, Partial<Record<string, number>>> = {}) {
  return MODELS.map((model) => ({
    model: model.id,
    event_type: "generate.text",
    is_rollup: 1,
    total_requests: 100,
    served: 100,
    errors_5xx: 0,
    fallback_rescues: 0,
    latency_p95_ms: 1500,
    ...(overrides[model.id] ?? {}),
  }));
}

function mockPollinations(overrides: Record<string, Partial<Record<string, number>>> = {}) {
  return async (path: string, init?: RequestInit) => {
    if (path === "/v1/models") return Response.json({ data: MODELS });
    if (path === "/models/status?minutes=30") return Response.json({ data: statusRows(overrides) });
    if (path === "/v1/responses") {
      const body = JSON.parse(init?.body as string);
      return Response.json({ routed_model: body.model }, { headers: { "x-downstream": "ok" } });
    }
    return new Response("not found", { status: 404 });
  };
}

test("classifies easy, code, deep and multimodal requests", () => {
  assert.equal(classify({ input: "What is 2 + 2?" }).profile, "FAST");
  assert.equal(classify({ input: "Debug this TypeScript function and explain the bug." }).profile, "CODE");
  assert.equal(classify({ input: "Research and synthesize the architecture trade-offs for a multi-step agent system." }).profile, "DEEP");
  assert.equal(classify({ input: [{ role: "user", content: [{ type: "input_image", image_url: "https://example.com/a.png" }, { type: "input_text", text: "Describe this." }] }] }).profile, "MULTIMODAL");
});

test("routes a cheap easy request to the cheapest healthy FAST candidate", async () => {
  const choice = await chooseModel("FAST", ["text"], mockPollinations());
  assert.equal(choice.model, "qwen/qwen3.7-flash");
  assert.match(choice.reason, /profile=FAST/);
});

test("routes coding to the lower-cost healthy CODE candidate", async () => {
  const choice = await chooseModel("CODE", ["text"], mockPollinations());
  assert.equal(choice.model, "qwen/qwen3.7-plus");
  assert.match(choice.reason, /profile=CODE/);
});

test("routes deep work to a strong DEEP candidate", async () => {
  const choice = await chooseModel("DEEP", ["text"], mockPollinations());
  assert.equal(choice.model, "x-ai/grok-4.3");
  assert.match(choice.reason, /profile=DEEP/);
});

test("avoids a degraded cheap model when recent 5xx health is bad", async () => {
  const choice = await chooseModel("FAST", ["text"], mockPollinations({
    "qwen/qwen3.7-flash": { served: 100, errors_5xx: 35, latency_p95_ms: 900 },
  }));
  assert.equal(choice.model, "inception/mercury-2.5-preview");
});

test("filters by input modality", async () => {
  const choice = await chooseModel("MULTIMODAL", ["text", "audio"], mockPollinations());
  assert.equal(choice.model, "google/gemini-3.8-flash");
});

test("forwards the original request and exposes a routing trace in headers", async () => {
  const body = { input: "What is 2 + 2?", max_output_tokens: 64, stream: false };
  const response = await agent({
    request: new Request("https://example.com/v1/responses", {
      method: "POST",
      body: JSON.stringify(body),
    }),
    pollinations: mockPollinations(),
  });
  assert.equal(response.headers.get("x-pollinations-router-model"), "qwen/qwen3.7-flash");
  assert.equal(response.headers.get("x-pollinations-router-profile"), "FAST");
  assert.match(response.headers.get("x-pollinations-router-reason") ?? "", /cost=/);
  assert.equal(response.headers.get("x-downstream"), "ok");
  const json = await response.json();
  assert.equal(json.routed_model, "qwen/qwen3.7-flash");
});
