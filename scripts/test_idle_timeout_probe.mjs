// Prerequisite: npm install openai@6.40.0 (no other dependency).
// Run: node --test scripts/test_idle_timeout_probe.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("idle_timeout_probe.mjs", import.meta.url));

function runProbe(args) {
    const started = performance.now();
    const run = spawnSync(process.execPath, [script, ...args], {
        encoding: "utf8", timeout: 2000,
    });
    assert.ifError(run.error);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stderr, "");
    const lines = run.stdout.trim().split("\n");
    assert.equal(lines.length, 1, "exactly one JSON line");
    return { result: JSON.parse(lines[0]), elapsed: performance.now() - started };
}

test("withheld headers hit the shortened SDK request timeout", () => {
    const { result, elapsed } = runProbe(["noheaders", "0.4", "--sdk-timeout-ms", "100"]);
    assert.equal(result.mode, "noheaders");
    assert.equal(result.delay, 0.4);
    assert.equal(result.ok, false);
    assert.equal(result.header_ms, null);
    assert.equal(result.first_chunk_ms, null);
    assert.match(result.error, /timed out/i);
    assert.ok(result.fail_ms < 1000);
    assert.ok(elapsed < 1000, "the whole run must take less than one second");
    assert.equal(typeof result.cause_code, "string");
    assert.equal(result.total_ms, undefined);
});

test("flushed headers stop the SDK timer before the delayed body", () => {
    const { result } = runProbe(["headers", "0.4", "--sdk-timeout-ms", "100"]);
    assert.equal(result.mode, "headers");
    assert.equal(result.delay, 0.4);
    assert.equal(result.ok, true);
    assert.notEqual(result.header_ms, null);
    assert.ok(result.header_ms < 100);
    assert.ok(result.first_chunk_ms >= 400);
    assert.ok(result.total_ms >= result.first_chunk_ms);
    assert.equal(result.error, "");
    assert.equal(result.cause_code, "");
    assert.equal(result.fail_ms, undefined);
});

test("missing arguments print usage and exit 2", () => {
    const run = spawnSync(process.execPath, [script], { encoding: "utf8", timeout: 1000 });
    assert.ifError(run.error);
    assert.equal(run.status, 2);
    assert.match(run.stderr, /^Usage: /);
    assert.equal(run.stdout, "");
});

test("probe source is sanitized and imports only built-ins and the SDK", () => {
    const source = readFileSync(script, "utf8");
    assert.doesNotMatch(source, /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u);
    for (const prefix of ["/" + "Users/", "/" + "home/"]) assert.ok(!source.includes(prefix));
    for (const match of source.matchAll(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g)) {
        assert.equal(match[0], "127.0.0.1");
    }
    const imports = source.matchAll(/(?:\bfrom\s*|\bimport\s*(?:\(\s*)?|\brequire(?:SDK)?\s*\(\s*)["']([^"']+)["']/g);
    for (const [, specifier] of imports) {
        assert.match(specifier, /^(?:node:[\w/]+|openai(?:\/[\w./-]+)?)$/);
    }
    assert.deepEqual([...source.matchAll(/process\.env\.([A-Z_]+)/g)].map((match) => match[1]), ["PROBE_SDK_DIR"]);
});
