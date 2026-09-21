# Pollinations Adaptive Router

A Pollinations code agent for quest #15017. It chooses a model per request using a deterministic task profile plus the live Pollinations model catalog and 30-minute model-health telemetry.

## Routing strategy

The router first classifies the request into one of six profiles: `FAST`, `BALANCED`, `CODE`, `DEEP`, `MULTIMODAL`, or `MULTIMODAL_DEEP`.

For that profile it then:

1. fetches `GET /v1/models` and `GET /models/status?minutes=30` in parallel;
2. restricts selection to a small quality-bounded candidate pool;
3. filters out models that cannot accept the request modalities;
4. scores remaining candidates on live 5xx rate, fallback rescues, p95 latency, blended token price, and a light quality-rank prior;
5. forwards the original request unchanged except for the selected `model`.

The router intentionally ignores 4xx rate when judging health because caller-side request errors are not evidence that the upstream model is degraded.

## Verifiable trace

Every response preserves the downstream body and adds three headers:

- `x-pollinations-router-model`
- `x-pollinations-router-profile`
- `x-pollinations-router-reason`

The reason header includes the profile, final score, blended token price, recent 5xx rate, and p95 latency.

## Three distinct routing demonstrations

The included test suite demonstrates materially different routes from the same deployed algorithm:

- easy text → `qwen/qwen3.7-flash` because it is the cheapest healthy FAST candidate in the fixture;
- coding → `qwen/qwen3.7-plus` because it clears the CODE pool while beating its peers on cost under equal health;
- deep analysis → `x-ai/grok-4.3` because it wins inside the DEEP quality pool on the weighted live-style score.

A separate test proves that a cheap model with a 35% recent 5xx rate is rejected in favor of a healthier alternative. Another test proves audio input filters out incompatible text/image-only models.

Run locally with Node 24+:

```bash
node --test agent.test.ts
```

Current result: **7/7 tests passing**.

## Deployment

Create a Pollinations code agent pointing at this public repository. The callable model becomes:

`muhamedsohaib/pollinations-adaptive-router`

The caller pays only for the selected downstream model; the routing decision itself uses catalog and health metadata rather than a separate classifier-model generation.
