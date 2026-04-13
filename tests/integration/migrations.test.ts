import {
  assert,
  assertEquals,
  assertMatch,
} from "@std/assert";

interface MigrationRow {
  version: string;
  checksum: string;
}

interface CanonicalizationCase {
  name: string;
  rule: string;
  input: string;
  expected: string;
}

interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

const REPO_ROOT = decodeURIComponent(
  new URL("../../", import.meta.url).pathname,
);
const MIGRATIONS_DIR = decodeURIComponent(
  new URL("../../migrations/", import.meta.url).pathname,
);
const MIGRATE_SCRIPT = decodeURIComponent(
  new URL("../../scripts/memex-migrate", import.meta.url).pathname,
);
const CANONICALIZATION_FIXTURES_URL = new URL(
  "../fixtures/canonicalization-cases.json",
  import.meta.url,
);

const TEST_DB_USER = Deno.env.get("MEMEX_TEST_DB_USER") ?? "memex_test";
const TEST_DB_PASSWORD = Deno.env.get("MEMEX_TEST_DB_PASSWORD") ?? "memex_test";
const TEST_DB_HOST = Deno.env.get("MEMEX_TEST_DB_HOST") ?? "127.0.0.1";
const TEST_DB_PORT = Deno.env.get("MEMEX_TEST_DB_PORT") ?? "55432";
const TEST_MCP_PASSWORD = Deno.env.get("MEMEX_TEST_MCP_PASSWORD") ??
  "memex_mcp_test_password";
const TEST_SYNC_PASSWORD = Deno.env.get("MEMEX_TEST_SYNC_PASSWORD") ??
  "memex_sync_test_password";

const DEFAULT_PSQL_COMMAND =
  "docker compose -p memex-test -f tests/compose.yaml exec -T postgres psql";
const DEFAULT_POSTGRES_EXEC_PREFIX =
  "docker compose -p memex-test -f tests/compose.yaml exec -T";

const PSQL_COMMAND = parseCommand(Deno.env.get("PSQL") ?? DEFAULT_PSQL_COMMAND);
const POSTGRES_EXEC_PREFIX =
  PSQL_COMMAND.at(-1) === "psql" && PSQL_COMMAND.length >= 2
    ? PSQL_COMMAND.slice(0, -2)
    : parseCommand(DEFAULT_POSTGRES_EXEC_PREFIX);
const POSTGRES_EXEC_COMMAND = [...POSTGRES_EXEC_PREFIX, "postgres"];
const PG_DUMP_COMMAND = [...POSTGRES_EXEC_COMMAND, "pg_dump"];

function parseCommand(command: string): string[] {
  const trimmed = command.trim();
  if (trimmed.length === 0) {
    throw new Error("command must not be empty");
  }

  const parts = trimmed.match(/'[^']*'|"[^"]*"|\S+/g) ?? [];
  return parts.map((part) => {
    if (
      (part.startsWith("'") && part.endsWith("'")) ||
      (part.startsWith('"') && part.endsWith('"'))
    ) {
      return part.slice(1, -1);
    }

    return part;
  });
}

function sqlIdentifier(identifier: string): string {
  assertMatch(identifier, /^[a-z0-9_]+$/);
  return identifier;
}

function textToHex(value: string): string {
  return bytesToHex(new TextEncoder().encode(value));
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return bytesToHex(new Uint8Array(digest));
}

async function runCommand(
  command: string[],
  options: {
    check?: boolean;
    cwd?: string;
    env?: Record<string, string>;
    stdin?: string | Uint8Array;
  } = {},
): Promise<CommandResult> {
  const { check = true, cwd = REPO_ROOT, env, stdin } = options;
  const process = new Deno.Command(command[0], {
    args: command.slice(1),
    cwd,
    env,
    stdin: stdin === undefined ? "null" : "piped",
    stdout: "piped",
    stderr: "piped",
  });

  const output = stdin === undefined
    ? await process.output()
    : await (async () => {
      const child = process.spawn();
      const writer = child.stdin.getWriter();
      const bytes = typeof stdin === "string"
        ? new TextEncoder().encode(stdin)
        : stdin;
      await writer.write(bytes);
      await writer.close();
      return await child.output();
    })();

  const result = {
    code: output.code,
    stdout: new TextDecoder().decode(output.stdout),
    stderr: new TextDecoder().decode(output.stderr),
  };

  if (!check || result.code === 0) {
    return result;
  }

  throw new Error(
    [
      `command failed (${result.code}): ${command.join(" ")}`,
      result.stdout.trim(),
      result.stderr.trim(),
    ].filter(Boolean).join("\n"),
  );
}

function psqlArgs(database: string, extraArgs: string[] = []): string[] {
  return [
    ...PSQL_COMMAND,
    "-X",
    "-v",
    "ON_ERROR_STOP=1",
    "-U",
    TEST_DB_USER,
    "-d",
    database,
    ...extraArgs,
  ];
}

async function runPsql(
  database: string,
  sql: string,
  options: {
    check?: boolean;
    extraArgs?: string[];
  } = {},
): Promise<CommandResult> {
  const extraArgs = options.extraArgs ?? [];
  return await runCommand(
    [...psqlArgs(database, extraArgs), "-c", sql],
    { check: options.check },
  );
}

async function runPsqlScript(
  database: string,
  sql: string,
  options: {
    check?: boolean;
    extraArgs?: string[];
  } = {},
): Promise<CommandResult> {
  return await runCommand(
    psqlArgs(database, options.extraArgs),
    { check: options.check, stdin: sql },
  );
}

async function queryValue(database: string, sql: string): Promise<string> {
  const result = await runPsql(database, sql, {
    extraArgs: ["-A", "-t", "-q"],
  });
  return result.stdout.trim();
}

async function queryRows(database: string, sql: string): Promise<string[][]> {
  const result = await runPsql(database, sql, {
    extraArgs: ["-A", "-t", "-q", "-F", "\t"],
  });

  const trimmed = result.stdout.trim();
  if (trimmed.length === 0) {
    return [];
  }

  return trimmed.split("\n").map((line) => line.split("\t"));
}

async function dropDatabase(database: string): Promise<void> {
  await runPsql(
    "postgres",
    `DROP DATABASE IF EXISTS ${sqlIdentifier(database)} WITH (FORCE);`,
  );
}

async function createDatabase(database: string): Promise<void> {
  await runPsql("postgres", `CREATE DATABASE ${sqlIdentifier(database)};`);
}

async function withFreshDatabase(
  database: string,
  fn: () => Promise<void>,
): Promise<void> {
  await dropDatabase(database);
  await createDatabase(database);

  try {
    await fn();
  } finally {
    await dropDatabase(database);
  }
}

function migrationEnv(
  database: string,
  overrides: Record<string, string> = {},
): Record<string, string> {
  return {
    ...Deno.env.toObject(),
    MEMEX_TEST_DB_HOST: TEST_DB_HOST,
    MEMEX_TEST_DB_PORT: TEST_DB_PORT,
    MEMEX_TEST_DB_USER: TEST_DB_USER,
    MEMEX_TEST_DB_PASSWORD: TEST_DB_PASSWORD,
    MEMEX_TEST_DB_NAME: database,
    MEMEX_TEST_MCP_PASSWORD: TEST_MCP_PASSWORD,
    MEMEX_TEST_SYNC_PASSWORD: TEST_SYNC_PASSWORD,
    PGHOST: TEST_DB_HOST,
    PGPORT: TEST_DB_PORT,
    PGUSER: TEST_DB_USER,
    PGPASSWORD: TEST_DB_PASSWORD,
    PGDATABASE: database,
    PSQL: Deno.env.get("PSQL") ?? DEFAULT_PSQL_COMMAND,
    ...overrides,
  };
}

async function runMigration(
  database: string,
  options: {
    check?: boolean;
    migrateDir?: string;
    migrateMax?: string;
  } = {},
): Promise<CommandResult> {
  const env = migrationEnv(database, {
    ...(options.migrateDir ? { MEMEX_MIGRATE_DIR: options.migrateDir } : {}),
    ...(options.migrateMax ? { MEMEX_MIGRATE_MAX: options.migrateMax } : {}),
  });

  return await runCommand([MIGRATE_SCRIPT], {
    check: options.check,
    cwd: REPO_ROOT,
    env,
  });
}

async function readSchemaMigrations(database: string): Promise<MigrationRow[]> {
  const rows = await queryRows(
    database,
    "SELECT version, checksum FROM schema_migrations ORDER BY version;",
  );

  return rows.map(([version, checksum]) => ({ version, checksum }));
}

async function copyMigrationsToTemp(
  options: { includeVersions?: string[] } = {},
): Promise<string> {
  const tempDir = await Deno.makeTempDir({ prefix: "memex-migrations-" });
  const includeVersions = options.includeVersions
    ? new Set(options.includeVersions)
    : null;

  for await (const entry of Deno.readDir(MIGRATIONS_DIR)) {
    if (!entry.isFile || !entry.name.endsWith(".sql")) {
      continue;
    }

    const version = entry.name.slice(0, 4);
    if (includeVersions !== null && !includeVersions.has(version)) {
      continue;
    }

    await Deno.copyFile(
      `${MIGRATIONS_DIR}${entry.name}`,
      `${tempDir}/${entry.name}`,
    );
  }

  return tempDir;
}

function normalizeSchemaDump(dump: string): string {
  const filtered = dump
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) =>
      !line.startsWith("--") &&
      !line.startsWith("SET ") &&
      !line.startsWith("SELECT pg_catalog.set_config(") &&
      !line.startsWith("\\connect ") &&
      !line.startsWith("\\restrict ") &&
      !line.startsWith("\\unrestrict ")
    );

  const collapsed: string[] = [];
  for (const line of filtered) {
    if (line === "" && collapsed.at(-1) === "") {
      continue;
    }
    collapsed.push(line);
  }

  return collapsed.join("\n").trim() + "\n";
}

async function schemaDump(database: string): Promise<string> {
  const result = await runCommand([
    ...PG_DUMP_COMMAND,
    "--schema-only",
    "--no-owner",
    "--no-privileges",
    "-U",
    TEST_DB_USER,
    "-d",
    database,
  ]);

  return normalizeSchemaDump(result.stdout);
}

async function writeContainerTempFile(content: Uint8Array): Promise<void> {
  await runCommand(
    [...POSTGRES_EXEC_COMMAND, "sh", "-c", "cat > /tmp/content.txt"],
    { stdin: content },
  );
}

async function insertThoughtWithContent(
  database: string,
  content: Uint8Array,
): Promise<bigint> {
  await writeContainerTempFile(content);
  const id = await queryValue(
    database,
    "INSERT INTO thoughts (content) VALUES (pg_read_file('/tmp/content.txt')::text) RETURNING id;",
  );
  return BigInt(id);
}

async function updateThoughtContent(
  database: string,
  id: bigint,
  content: Uint8Array,
): Promise<void> {
  await writeContainerTempFile(content);
  await runPsql(
    database,
    `UPDATE thoughts SET content = pg_read_file('/tmp/content.txt')::text WHERE id = ${id};`,
  );
}

async function loadCanonicalizationFixtures(): Promise<CanonicalizationCase[]> {
  const fixtures = JSON.parse(
    await Deno.readTextFile(CANONICALIZATION_FIXTURES_URL),
  ) as CanonicalizationCase[];
  assertEquals(fixtures.length, 22);
  return fixtures;
}

Deno.test("Sprint 001 migrations and schema behaviors", async (t) => {
  await t.step("full-apply scenario", async (t) => {
    await withFreshDatabase("memex_it_full_apply", async () => {
      let freshApplyRows: MigrationRow[] = [];

      await t.step("fresh migration apply", async () => {
        const result = await runMigration("memex_it_full_apply");
        assertEquals(result.code, 0);
        assert(result.stdout.includes("applied 0001"));
        assert(result.stdout.includes("applied 0009"));

        freshApplyRows = await readSchemaMigrations("memex_it_full_apply");
        assertEquals(
          freshApplyRows.map((row) => row.version),
          [
            "0001",
            "0002",
            "0003",
            "0004",
            "0005",
            "0006",
            "0007",
            "0008",
            "0009",
          ],
        );

        for (const row of freshApplyRows) {
          assertEquals(row.checksum.length, 64);
          assertMatch(row.checksum, /^[0-9a-f]{64}$/);
        }
      });

      await t.step("no-op rerun", async () => {
        const before = freshApplyRows;
        const result = await runMigration("memex_it_full_apply");
        assertEquals(result.code, 0);
        assert(result.stdout.includes("no pending migrations"));

        const after = await readSchemaMigrations("memex_it_full_apply");
        assertEquals(after, before);
      });
    });
  });

  await t.step("staged-apply scenario", async (t) => {
    const fullDatabase = "memex_it_full_apply";
    const stagedDatabase = "memex_it_staged_apply";

    await dropDatabase(fullDatabase);
    await dropDatabase(stagedDatabase);
    await createDatabase(fullDatabase);
    await createDatabase(stagedDatabase);

    try {
      await t.step("staged-vs-full schema equivalence", async () => {
        const stagedFirstPass = await runMigration(stagedDatabase, {
          migrateMax: "0005",
        });
        assertEquals(stagedFirstPass.code, 0);

        const stagedRowsAfterFirstPass = await readSchemaMigrations(
          stagedDatabase,
        );
        assertEquals(
          stagedRowsAfterFirstPass.map((row) => row.version),
          ["0001", "0002", "0003", "0004", "0005"],
        );

        const stagedSecondPass = await runMigration(stagedDatabase);
        assertEquals(stagedSecondPass.code, 0);

        const fullPass = await runMigration(fullDatabase);
        assertEquals(fullPass.code, 0);

        const stagedDump = await schemaDump(stagedDatabase);
        const fullDump = await schemaDump(fullDatabase);
        assertEquals(stagedDump, fullDump);
      });
    } finally {
      await dropDatabase(stagedDatabase);
      await dropDatabase(fullDatabase);
    }
  });

  await t.step("checksum-drift scenario", async (t) => {
    await withFreshDatabase("memex_it_checksum", async () => {
      const tempDir = await copyMigrationsToTemp();

      try {
        const firstRun = await runMigration("memex_it_checksum", {
          migrateDir: tempDir,
        });
        assertEquals(firstRun.code, 0);

        const rowsBeforeTamper = await readSchemaMigrations(
          "memex_it_checksum",
        );
        await Deno.writeTextFile(
          `${tempDir}/0004_add_content_fingerprint.sql`,
          `${await Deno.readTextFile(
            `${tempDir}/0004_add_content_fingerprint.sql`,
          )}\n-- tampered\n`,
        );

        await t.step("checksum drift detection", async () => {
          const secondRun = await runMigration("memex_it_checksum", {
            check: false,
            migrateDir: tempDir,
          });
          assertEquals(secondRun.code, 2);
          assert(secondRun.stderr.includes("checksum mismatch 0004"));

          const rowsAfterTamper = await readSchemaMigrations(
            "memex_it_checksum",
          );
          assertEquals(rowsAfterTamper, rowsBeforeTamper);
        });
      } finally {
        await Deno.remove(tempDir, { recursive: true });
      }
    });
  });

  await t.step("bad-migration scenario", async (t) => {
    await withFreshDatabase("memex_it_failed_migration", async () => {
      const tempDir = await copyMigrationsToTemp({
        includeVersions: ["0001", "0002", "0003", "0004"],
      });

      try {
        await Deno.writeTextFile(
          `${tempDir}/0005_bad.sql`,
          "SELECT 1/0;\n",
        );

        await t.step("synthetic bad-migration apply failure", async () => {
          const result = await runMigration("memex_it_failed_migration", {
            check: false,
            migrateDir: tempDir,
          });
          assertEquals(result.code, 1);
          assert(result.stderr.includes("failed version 0005"));

          const rows = await readSchemaMigrations("memex_it_failed_migration");
          assertEquals(
            rows.map((row) => row.version),
            ["0001", "0002", "0003", "0004"],
          );

          const fingerprintColumn = await queryValue(
            "memex_it_failed_migration",
            "SELECT column_name FROM information_schema.columns WHERE table_name = 'thoughts' AND column_name = 'content_fingerprint';",
          );
          assertEquals(fingerprintColumn, "content_fingerprint");

          const failedRowCount = await queryValue(
            "memex_it_failed_migration",
            "SELECT count(*) FROM schema_migrations WHERE version = '0005';",
          );
          assertEquals(failedRowCount, "0");
        });
      } finally {
        await Deno.remove(tempDir, { recursive: true });
      }
    });
  });

  await t.step("behavior scenario", async (t) => {
    await withFreshDatabase("memex_it_behavior", async () => {
      const migrateResult = await runMigration("memex_it_behavior");
      assertEquals(migrateResult.code, 0);

      const fixtures = await loadCanonicalizationFixtures();

      await t.step("canonicalization on insert", async () => {
        for (const fixture of fixtures) {
          const id = await insertThoughtWithContent(
            "memex_it_behavior",
            new TextEncoder().encode(fixture.input),
          );

          const storedHex = await queryValue(
            "memex_it_behavior",
            `SELECT encode(convert_to(content, 'UTF8'), 'hex') FROM thoughts WHERE id = ${id};`,
          );
          assertEquals(storedHex, textToHex(fixture.expected), fixture.name);
        }
      });

      await t.step("canonicalization on update", async () => {
        for (const fixture of fixtures) {
          const id = await insertThoughtWithContent(
            "memex_it_behavior",
            new TextEncoder().encode(fixture.expected),
          );

          await updateThoughtContent(
            "memex_it_behavior",
            id,
            new TextEncoder().encode(fixture.input),
          );

          const storedHex = await queryValue(
            "memex_it_behavior",
            `SELECT encode(convert_to(content, 'UTF8'), 'hex') FROM thoughts WHERE id = ${id};`,
          );
          assertEquals(storedHex, textToHex(fixture.expected), fixture.name);
        }
      });

      await t.step("fingerprint generation", async () => {
        const fixture = fixtures.find((entry) => entry.name === "crlf-to-lf") ??
          fixtures[0];
        const id = await insertThoughtWithContent(
          "memex_it_behavior",
          new TextEncoder().encode(fixture.input),
        );
        const row = await queryRows(
          "memex_it_behavior",
          `SELECT content_fingerprint, length(content_fingerprint)::text FROM thoughts WHERE id = ${id};`,
        );
        const [fingerprint, length] = row[0];
        assertEquals(length, "64");
        assertEquals(fingerprint, await sha256Hex(fixture.expected));
      });

      await t.step("updated_at trigger", async () => {
        await runPsql("memex_it_behavior", "TRUNCATE sync_log;");
        const id = await insertThoughtWithContent(
          "memex_it_behavior",
          new TextEncoder().encode("before\n"),
        );

        const before = await queryRows(
          "memex_it_behavior",
          `SELECT EXTRACT(EPOCH FROM created_at)::text, EXTRACT(EPOCH FROM updated_at)::text FROM thoughts WHERE id = ${id};`,
        );
        await runPsqlScript(
          "memex_it_behavior",
          `
SELECT pg_sleep(0.02);
UPDATE thoughts SET content = 'after' WHERE id = ${id};
`,
        );
        const after = await queryRows(
          "memex_it_behavior",
          `SELECT EXTRACT(EPOCH FROM created_at)::text, EXTRACT(EPOCH FROM updated_at)::text FROM thoughts WHERE id = ${id};`,
        );

        assertEquals(after[0][0], before[0][0]);
        assert(Number(after[0][1]) > Number(before[0][1]));
      });

      await t.step("sync log emit path", async () => {
        await runPsqlScript(
          "memex_it_behavior",
          `
TRUNCATE sync_log RESTART IDENTITY;
TRUNCATE thoughts RESTART IDENTITY CASCADE;
`,
        );

        const id = await insertThoughtWithContent(
          "memex_it_behavior",
          new TextEncoder().encode("human write"),
        );
        await runPsql(
          "memex_it_behavior",
          `UPDATE thoughts SET content = 'human update' WHERE id = ${id};`,
        );
        await runPsql(
          "memex_it_behavior",
          `DELETE FROM thoughts WHERE id = ${id};`,
        );

        const rows = await queryRows(
          "memex_it_behavior",
          "SELECT operation, thought_id::text FROM sync_log ORDER BY seq;",
        );
        assertEquals(rows, [
          ["INSERT", id.toString()],
          ["UPDATE", id.toString()],
          ["DELETE", id.toString()],
        ]);
      });

      await t.step("sync log daemon suppression", async () => {
        await runPsqlScript(
          "memex_it_behavior",
          `
TRUNCATE sync_log RESTART IDENTITY;
TRUNCATE thoughts RESTART IDENTITY CASCADE;
`,
        );

        const id = await insertThoughtWithContent(
          "memex_it_behavior",
          new TextEncoder().encode("seed\n"),
        );
        await runPsql(
          "memex_it_behavior",
          "TRUNCATE sync_log RESTART IDENTITY;",
        );
        // SET LOCAL is transaction-scoped, so this must stay one psql session or the test becomes a false-positive.
        await runPsqlScript(
          "memex_it_behavior",
          `
BEGIN;
SET LOCAL app.sync_source = 'daemon';
UPDATE thoughts SET content = 'daemon update' WHERE id = ${id};
INSERT INTO thoughts (content) VALUES ('daemon insert');
DELETE FROM thoughts WHERE id = ${id};
COMMIT;
`,
        );

        const count = await queryValue(
          "memex_it_behavior",
          "SELECT count(*) FROM sync_log;",
        );
        assertEquals(count, "0");
      });
    });
  });

  await t.step("role-boundary scenario", async (t) => {
    await withFreshDatabase("memex_it_roles", async () => {
      const migrateResult = await runMigration("memex_it_roles");
      assertEquals(migrateResult.code, 0);

      await insertThoughtWithContent(
        "memex_it_roles",
        new TextEncoder().encode("role boundary\n"),
      );

      await t.step("role boundary", async () => {
        const mcpDelete = await runCommand([
          ...POSTGRES_EXEC_PREFIX,
          "-e",
          `PGPASSWORD=${TEST_MCP_PASSWORD}`,
          "postgres",
          "psql",
          "-X",
          "-v",
          "VERBOSITY=verbose",
          "-h",
          "127.0.0.1",
          "-U",
          "memex_mcp",
          "-d",
          "memex_it_roles",
          "-c",
          "DELETE FROM thoughts;",
        ], { check: false });
        assert(mcpDelete.code !== 0);
        assertMatch(mcpDelete.stderr, /42501/);

        const syncDelete = await runCommand([
          ...POSTGRES_EXEC_PREFIX,
          "-e",
          `PGPASSWORD=${TEST_SYNC_PASSWORD}`,
          "postgres",
          "psql",
          "-X",
          "-h",
          "127.0.0.1",
          "-U",
          "memex_sync",
          "-d",
          "memex_it_roles",
          "-c",
          "DELETE FROM thoughts;",
        ]);
        assertMatch(syncDelete.stdout, /DELETE 1/);
      });
    });
  });
});
