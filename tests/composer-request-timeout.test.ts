import assert from "node:assert/strict";
import test from "node:test";
import { request } from "../src/api";

for (const stage of ["headers", "body"] as const) {
  test(`composer deadline covers stalled ${stage} without retrying the write`, async (t) => {
    let calls = 0;
    let capturedSignal: AbortSignal | null | undefined;
    t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
      calls += 1;
      capturedSignal = init.signal;
      const stalled = () => new Promise((_resolve, reject) => {
        init.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      });
      return stage === "headers" ? stalled() : { ok: true, status: 202, json: stalled };
    });
    await assert.rejects(request("/test", { method: "POST" }, { timeoutMs: 15 }), /请求确认超时.*未自动重发/);
    assert.equal(calls, 1);
    assert.equal(capturedSignal?.aborted, true);
  });
}

test("successful composer response clears its deadline", async (t) => {
  let signal: AbortSignal | null | undefined;
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    signal = init.signal;
    return new Response(JSON.stringify({ accepted: true }), { status: 202 });
  });
  assert.deepEqual(await request("/test", {}, { timeoutMs: 15 }), { accepted: true });
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(signal?.aborted, false);
});

test("caller cancellation remains cancellation instead of a timeout", async (t) => {
  const controller = new AbortController();
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => new Promise((_resolve, reject) => {
    init.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
  }));
  const result = request("/test", { signal: controller.signal }, { timeoutMs: 1000 });
  controller.abort();
  await assert.rejects(result, { name: "AbortError" });
});

test("proofreading upload completion is independent of the transcription response", async (t) => {
  const { api, setCsrf } = await import("../src/api");
  let transport: FakeXhr;
  class FakeXhr {
    upload: { onload?: () => void } = {};
    onload?: () => void; onerror?: () => void; ontimeout?: () => void;
    responseText = ""; status = 0; timeout = 0; withCredentials = false;
    headers: Record<string, string> = {};
    open(method: string, url: string) { assert.equal(method, "POST"); assert.ok(url.endsWith("/api/transcriptions")); }
    setRequestHeader(key: string, value: string) { this.headers[key] = value; }
    send(body: FormData) { assert.equal(body.get("draftText"), "proofreading text"); transport = this; }
  }
  const old = Object.getOwnPropertyDescriptor(globalThis, "XMLHttpRequest");
  Object.defineProperty(globalThis, "XMLHttpRequest", { configurable: true, value: FakeXhr });
  t.after(() => { if (old) Object.defineProperty(globalThis, "XMLHttpRequest", old); else Reflect.deleteProperty(globalThis, "XMLHttpRequest"); setCsrf(); });
  setCsrf("test-csrf");
  let uploadFinished = false, responseFinished = false;
  const result = api.transcribeAudio(new Blob(["fixture"]), "test.wav", { draftText: "proofreading text", onUploadComplete: () => { uploadFinished = true; } }).then(value => { responseFinished = true; return value; });
  assert.equal(transport!.headers["X-CSRF-Token"], "test-csrf");
  transport!.upload.onload!(); await Promise.resolve();
  assert.equal(uploadFinished, true); assert.equal(responseFinished, false);
  transport!.status = 200; transport!.responseText = JSON.stringify({ text: "recognized", transcriptionId: "test-id" }); transport!.onload!();
  assert.deepEqual(await result, { text: "recognized", transcriptionId: "test-id" });
});
