/*
 * Sprint 000 mock inference surface for the memex MCP server boundary in
 * memex-architecture.md Section 9. This service is deliberately incomplete:
 * it only implements the minimal offline contract the test platform needs.
 */

const CHAT_FIXTURE_ENV = "MOCK_INFERENCE_CHAT_FIXTURES";
const SERVICE_VERSION = "0.1.0";
const EMBEDDING_DIMENSIONS = 1536;
const EXPANSION_BLOCKS = 192;
const EMBEDDING_MODEL_FALLBACK = "openai/text-embedding-3-small";
const FAIL_EMBED_TRIGGER = "__fail_embed__";
const SLOW_EMBED_TRIGGER = "__slow_embed__";
const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
};

export const defaultChatFixtureUrl = new URL("./fixtures/chat.json", import.meta.url);

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function errorResponse(status, type, message, extra = {}) {
  return jsonResponse(
    {
      error: {
        type,
        message,
        ...extra,
      },
    },
    status,
  );
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function toUtf8Bytes(text) {
  return new TextEncoder().encode(text);
}

function encodeU32Be(value) {
  return Uint8Array.of(
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  );
}

function bytesToHex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256Bytes(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return new Uint8Array(digest);
}

async function sha256HexFromText(text) {
  return bytesToHex(await sha256Bytes(toUtf8Bytes(text)));
}

function canonicalizeJsonValue(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalizeJsonValue(entry));
  }
  if (isRecord(value)) {
    const sorted = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = canonicalizeJsonValue(value[key]);
    }
    return sorted;
  }
  return value;
}

export function stableStringify(value) {
  return JSON.stringify(canonicalizeJsonValue(value));
}

async function requestHashHex(value) {
  return sha256HexFromText(stableStringify(value));
}

async function expandSeed(seed) {
  const output = new Uint8Array(EXPANSION_BLOCKS * 32);

  for (let counter = 0; counter < EXPANSION_BLOCKS; counter += 1) {
    const material = new Uint8Array(seed.length + 4);
    material.set(seed, 0);
    material.set(encodeU32Be(counter), seed.length);
    output.set(await sha256Bytes(material), counter * 32);
  }

  return output;
}

export async function embeddingVectorForInput(inputText) {
  const seed = await sha256Bytes(toUtf8Bytes(inputText));
  const expanded = await expandSeed(seed);
  const view = new DataView(expanded.buffer, expanded.byteOffset, expanded.byteLength);
  const vector = new Array(EMBEDDING_DIMENSIONS);
  let sumSquares = 0;

  for (let index = 0; index < EMBEDDING_DIMENSIONS; index += 1) {
    const unsigned = view.getUint32(index * 4, false);
    const value = (unsigned / 4294967295.0) * 2.0 - 1.0;
    vector[index] = value;
    sumSquares += value * value;
  }

  const norm = Math.sqrt(sumSquares);
  for (let index = 0; index < vector.length; index += 1) {
    vector[index] = vector[index] / norm;
  }

  return vector;
}

function normalizeEmbeddingInputs(value) {
  if (typeof value === "string") {
    return [value];
  }
  if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) {
    return value;
  }
  return null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function embeddingResponseBody(model, inputs) {
  const data = [];

  for (let index = 0; index < inputs.length; index += 1) {
    data.push({
      object: "embedding",
      index,
      embedding: await embeddingVectorForInput(inputs[index]),
    });
  }

  return {
    object: "list",
    data,
    model,
    usage: {
      prompt_tokens: 0,
      total_tokens: 0,
    },
  };
}

export async function loadChatFixtures(readTextFile, fixtureSource = defaultChatFixtureUrl) {
  const text = await readTextFile(fixtureSource);
  const fixtures = JSON.parse(text);

  if (!Array.isArray(fixtures)) {
    throw new Error("chat fixtures must be a top-level array");
  }

  return fixtures;
}

export async function buildChatFixtureIndex(fixtures) {
  const index = new Map();

  for (const fixture of fixtures) {
    if (!isRecord(fixture) || !isRecord(fixture.request) || !isRecord(fixture.response)) {
      throw new Error("chat fixtures must contain object request/response pairs");
    }

    const hash = await requestHashHex(fixture.request);
    if (index.has(hash)) {
      throw new Error(`duplicate chat fixture hash: ${hash}`);
    }

    index.set(hash, fixture.response);
  }

  return index;
}

export async function loadChatFixtureIndex(readTextFile, fixtureSource = defaultChatFixtureUrl) {
  return buildChatFixtureIndex(await loadChatFixtures(readTextFile, fixtureSource));
}

function requestLogger(method, path, status, elapsedMs) {
  console.log(`${method} ${path} ${status} ${Math.round(elapsedMs)}`);
}

export function createApp({ chatFixtureIndex }) {
  return async function handleRequest(request) {
    const startedAt = performance.now();
    const { pathname } = new URL(request.url);
    let status = 500;

    try {
      if (request.method === "GET" && pathname === "/health") {
        status = 200;
        return jsonResponse({
          status: "ok",
          service: "mock-inference",
          version: SERVICE_VERSION,
        });
      }

      if (request.method === "POST" && pathname === "/embeddings") {
        let body;
        try {
          body = await request.json();
        } catch (_error) {
          status = 400;
          return errorResponse(400, "mock_invalid_json", "Request body must be valid JSON");
        }

        const inputs = normalizeEmbeddingInputs(body?.input);
        const model = typeof body?.model === "string" ? body.model : EMBEDDING_MODEL_FALLBACK;

        if (inputs === null) {
          status = 400;
          return errorResponse(
            400,
            "mock_invalid_request",
            "Embeddings requests require input as a string or string[]",
          );
        }

        if (inputs.some((input) => input === FAIL_EMBED_TRIGGER)) {
          status = 500;
          return errorResponse(
            500,
            "mock_embedding_failure",
            "Triggered mock embedding failure",
          );
        }

        if (inputs.some((input) => input === SLOW_EMBED_TRIGGER)) {
          await sleep(5000);
        }

        status = 200;
        return jsonResponse(await embeddingResponseBody(model, inputs));
      }

      if (request.method === "POST" && pathname === "/chat/completions") {
        let body;
        try {
          body = await request.json();
        } catch (_error) {
          status = 400;
          return errorResponse(400, "mock_invalid_json", "Request body must be valid JSON");
        }

        if (!isRecord(body)) {
          status = 400;
          return errorResponse(400, "mock_invalid_request", "Chat request must be a JSON object");
        }

        const hash = await requestHashHex(body);
        const response = chatFixtureIndex.get(hash);

        if (!response) {
          status = 400;
          return errorResponse(
            400,
            "mock_chat_fixture_missing",
            `No chat fixture found for request hash ${hash}`,
            { request_hash: hash },
          );
        }

        status = 200;
        return jsonResponse(response);
      }

      status = 404;
      return errorResponse(404, "mock_not_found", `Unknown route ${request.method} ${pathname}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unhandled mock server error";
      status = 500;
      return errorResponse(500, "mock_internal_error", message);
    } finally {
      requestLogger(request.method, pathname, status, performance.now() - startedAt);
    }
  };
}

if (typeof Deno !== "undefined" && import.meta.main) {
  const fixtureSource = Deno.env.get(CHAT_FIXTURE_ENV) ?? defaultChatFixtureUrl;
  const chatFixtureIndex = await loadChatFixtureIndex((path) => Deno.readTextFile(path), fixtureSource);
  const port = Number(Deno.env.get("PORT") ?? "8000");

  Deno.serve({ port }, createApp({ chatFixtureIndex }));
  console.log(
    `mock-inference listening on :${port} with ${chatFixtureIndex.size} chat fixture(s)`,
  );
}
