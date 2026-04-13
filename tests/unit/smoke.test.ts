import { assert, assertEquals, assertExists } from "@std/assert";

const DB_HOST = Deno.env.get("MEMEX_TEST_DB_HOST") ?? "127.0.0.1";
const DB_PORT = Number(Deno.env.get("MEMEX_TEST_DB_PORT") ?? "55432");
const INFERENCE_BASE = Deno.env.get("MEMEX_TEST_INFERENCE_BASE") ?? "http://127.0.0.1:58000";
const EMBEDDING_MODEL = "openai/text-embedding-3-small";
const CHAT_MODEL = "openai/gpt-4o-mini";
const embeddingsFixtureUrl = new URL("../mock-inference/fixtures/embeddings.json", import.meta.url);
const chatFixtureUrl = new URL("../mock-inference/fixtures/chat.json", import.meta.url);
const canonicalizationCasesUrl = new URL("../fixtures/canonicalization-cases.json", import.meta.url);

function inferenceUrl(path: string): string {
  return new URL(path, `${INFERENCE_BASE}/`).toString();
}

async function readJsonFile<T>(url: URL): Promise<T> {
  return JSON.parse(await Deno.readTextFile(url));
}

async function postJson(path: string, body: unknown): Promise<Response> {
  return fetch(inferenceUrl(path), {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

async function responseJson(response: Response): Promise<unknown> {
  return JSON.parse(await response.text());
}

function vectorNorm(values: number[]): number {
  let sumSquares = 0;
  for (const value of values) {
    sumSquares += value * value;
  }
  return Math.sqrt(sumSquares);
}

async function withTimeout<T>(label: string, timeoutMs: number, fn: () => Promise<T>): Promise<T> {
  let timerId: number | undefined;
  try {
    return await Promise.race([
      fn(),
      new Promise<T>((_, reject) => {
        timerId = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timerId !== undefined) {
      clearTimeout(timerId);
    }
  }
}

Deno.test("pg reachable from host", async () => {
  const connection = await Deno.connect({
    hostname: DB_HOST,
    port: DB_PORT,
    transport: "tcp",
  });
  connection.close();
});

Deno.test("mock /health", async () => {
  const response = await fetch(inferenceUrl("/health"));
  assertEquals(response.status, 200);

  const body = await responseJson(response) as Record<string, unknown>;
  assertEquals(body.status, "ok");
  assertEquals(body.service, "mock-inference");
  assertEquals(body.version, "0.1.0");
});

Deno.test("mock /embeddings golden replay", async () => {
  const fixtures = await readJsonFile<Array<{ request: unknown; response: unknown }>>(embeddingsFixtureUrl);

  for (const fixture of fixtures) {
    const response = await postJson("/embeddings", fixture.request);
    assertEquals(response.status, 200);
    assertEquals(await responseJson(response), fixture.response);
  }
});

Deno.test("mock /embeddings deterministic", async () => {
  const request = {
    model: EMBEDDING_MODEL,
    input: "determinism check",
  };

  const [firstResponse, secondResponse] = await Promise.all([
    postJson("/embeddings", request),
    postJson("/embeddings", request),
  ]);

  assertEquals(firstResponse.status, 200);
  assertEquals(secondResponse.status, 200);

  const firstBody = await responseJson(firstResponse) as Record<string, unknown>;
  const secondBody = await responseJson(secondResponse) as Record<string, unknown>;
  assertEquals(firstBody, secondBody);

  const data = firstBody.data as Array<Record<string, unknown>>;
  const vector = data[0].embedding as number[];
  assertEquals(vector.length, 1536);
  assert(Math.abs(vectorNorm(vector) - 1) < 1e-6);
});

Deno.test("mock /embeddings varies by input", async () => {
  const [firstResponse, secondResponse] = await Promise.all([
    postJson("/embeddings", { model: EMBEDDING_MODEL, input: "alpha input" }),
    postJson("/embeddings", { model: EMBEDDING_MODEL, input: "beta input" }),
  ]);

  assertEquals(firstResponse.status, 200);
  assertEquals(secondResponse.status, 200);

  const firstVector = ((await responseJson(firstResponse)) as Record<string, Array<Record<string, number[]>>>)
    .data[0].embedding;
  const secondVector = ((await responseJson(secondResponse)) as Record<string, Array<Record<string, number[]>>>)
    .data[0].embedding;

  assert(firstVector.some((value, index) => value !== secondVector[index]));
});

Deno.test("mock __fail_embed__", async () => {
  const response = await postJson("/embeddings", {
    model: EMBEDDING_MODEL,
    input: "__fail_embed__",
  });

  assertEquals(response.status, 500);
  const body = await responseJson(response) as { error?: Record<string, unknown> };
  assertExists(body.error);
  assertEquals(body.error.type, "mock_embedding_failure");
  assertEquals(body.error.message, "Triggered mock embedding failure");
});

Deno.test("mock __slow_embed__", async () => {
  await withTimeout("mock __slow_embed__", 20_000, async () => {
    const startedAt = performance.now();
    const response = await postJson("/embeddings", {
      model: EMBEDDING_MODEL,
      input: "__slow_embed__",
    });
    const elapsedMs = performance.now() - startedAt;

    assertEquals(response.status, 200);
    const body = await responseJson(response) as Record<string, unknown>;
    const data = body.data as Array<Record<string, unknown>>;

    assertEquals(data[0].embedding instanceof Array, true);
    assert(elapsedMs >= 4500);
    assert(elapsedMs < 15000);
  });
});

Deno.test("mock /chat/completions golden replay", async () => {
  const fixtures = await readJsonFile<Array<{ request: unknown; response: unknown }>>(chatFixtureUrl);

  for (const fixture of fixtures) {
    const response = await postJson("/chat/completions", fixture.request);
    assertEquals(response.status, 200);
    assertEquals(await responseJson(response), fixture.response);
  }
});

Deno.test("mock /chat/completions missing fixture", async () => {
  const response = await postJson("/chat/completions", {
    model: CHAT_MODEL,
    messages: [
      { role: "user", content: "not a fixture" },
    ],
  });

  assertEquals(response.status, 400);
  const body = await responseJson(response) as { error?: Record<string, unknown> };
  assertExists(body.error);
  assertEquals(body.error.type, "mock_chat_fixture_missing");
  assert(typeof body.error.request_hash === "string");
  assert(/^[0-9a-f]{64}$/.test(body.error.request_hash as string));
});

Deno.test("canonicalization fixture well-formed", async () => {
  const fixtures = await readJsonFile<Array<Record<string, unknown>>>(canonicalizationCasesUrl);
  assert(Array.isArray(fixtures));
  assert(fixtures.length >= 22);

  const names = new Set<string>();
  const rules = new Set<string>();

  for (const fixture of fixtures) {
    assert(typeof fixture.name === "string");
    assert(typeof fixture.rule === "string");
    assert(typeof fixture.input === "string");
    assert(typeof fixture.expected === "string");
    assert(!names.has(fixture.name as string));

    names.add(fixture.name as string);
    rules.add(fixture.rule as string);
  }

  for (const requiredRule of [
    "bom-stripping",
    "crlf-to-lf",
    "trailing-newline-collapse",
    "nfc",
    "internal-whitespace",
    "boundary",
  ]) {
    assert(rules.has(requiredRule), `missing canonicalization rule coverage for ${requiredRule}`);
  }

  for (const requiredCase of [
    "empty-string-boundary",
    "single-newline-idempotent",
    "whitespace-only-content",
  ]) {
    assert(names.has(requiredCase), `missing canonicalization boundary case ${requiredCase}`);
  }
});
