// Tests the OpenAI SDK plus the Node.js HTTP client against a synthetic server.
// This transport-only probe does not test the harness adapter or its semantic watchdog.
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";

const usage = "Usage: node scripts/idle_timeout_probe.mjs <headers|noheaders> <delay_seconds> [--sdk-timeout-ms N]";

async function main() {
    const args = process.argv.slice(2);
    const [mode, delayText, option, timeoutText] = args;
    const delay = Number(delayText);
    const sdkTimeout = timeoutText === undefined ? 600000 : Number(timeoutText);
    if (!["headers", "noheaders"].includes(mode)
        || !delayText?.trim() || !Number.isFinite(delay) || delay < 0
        || !Number.isFinite(sdkTimeout) || sdkTimeout <= 0
        || !(args.length === 2 || (args.length === 4 && option === "--sdk-timeout-ms"))) {
        console.error(usage);
        process.exitCode = 2;
        return;
    }

    const requireSDK = createRequire(resolve(process.env.PROBE_SDK_DIR || process.cwd(), "package.json"));
    if (requireSDK("openai/version").VERSION !== "6.40.0") {
        throw new Error("The probe requires openai@6.40.0.");
    }
    const { default: OpenAI } = requireSDK("openai");
    if (delay >= 60) {
        console.error(`Warning: this run will take ${delay} seconds unless a timeout ends it earlier.`);
    }

    const loopback = "127.0.0.1";
    const server = createServer((request, response) => {
        request.resume();
        request.on("end", () => {
            response.writeHead(200, { "Content-Type": "text/event-stream" });
            if (mode === "headers") response.flushHeaders();
            const timer = setTimeout(() => {
                const chunk = {
                    id: "probe", object: "chat.completion.chunk", created: 0, model: "probe",
                    choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }],
                };
                response.end(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`);
            }, delay * 1000);
            response.once("close", () => clearTimeout(timer));
        });
    });
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, loopback, resolve);
    });

    const result = { mode, delay, ok: false, header_ms: null, first_chunk_ms: null };
    const started = performance.now();
    const elapsed = () => Math.round(performance.now() - started);
    try {
        const client = new OpenAI({
            apiKey: "dummy-key",
            baseURL: `http://${loopback}:${server.address().port}/v1`,
            maxRetries: 0,
            fetch: async (...fetchArgs) => {
                const response = await fetch(...fetchArgs);
                result.header_ms = elapsed();
                return response;
            },
        });
        const stream = await client.chat.completions.create({
            model: "probe", messages: [{ role: "user", content: "probe" }], stream: true,
        }, { timeout: sdkTimeout });
        for await (const chunk of stream) {
            if (result.first_chunk_ms === null) result.first_chunk_ms = elapsed();
        }
        result.ok = true;
        result.total_ms = elapsed();
        result.error = "";
        result.cause_code = "";
    } catch (error) {
        result.fail_ms = elapsed();
        result.error = String(error.message).slice(0, 160);
        result.cause_code = "";
        for (let cause = error.cause; cause; cause = cause.cause) {
            if (cause.code) {
                result.cause_code = String(cause.code);
                break;
            }
        }
    } finally {
        await new Promise((resolve) => {
            server.close(resolve);
            server.closeAllConnections();
        });
    }
    console.log(JSON.stringify(result));
}

main().catch((error) => {
    console.error(`Probe setup failed (${error.code || "SETUP_ERROR"}); use openai@6.40.0 in the working directory or PROBE_SDK_DIR and allow loopback listening.`);
    process.exitCode = 1;
});
