import assert from "node:assert/strict";
import test from "node:test";
import { api, ApiError, setCsrf, type VoiceUploadOptions } from "../src/api";

for (const route of ["proofread", "send"] as const) {
  test(`${route}: byte progress, unknown totals, response acknowledgement and retry`, async (t) => {
    const requests: FakeXhr[] = [];
    class FakeXhr {
      upload: { onprogress?: (event: { lengthComputable: boolean; loaded: number; total: number }) => void; onload?: () => void } = {};
      onload?: () => void; onerror?: () => void; ontimeout?: () => void; onabort?: () => void;
      responseText = ""; status = 0; timeout = 0; withCredentials = false;
      headers: Record<string, string> = {};
      open(method: string, url: string) {
        assert.equal(method, "POST");
        assert.ok(url.endsWith(route === "send" ? "/api/conversations/conversation-id/voice-messages" : "/api/transcriptions"));
      }
      setRequestHeader(key: string, value: string) { this.headers[key] = value; }
      send(body: FormData) {
        assert.equal(body.get("clientRecordingId"), "same-recording-id");
        assert.equal(body.get(route === "send" ? "message" : "draftText"), "retained text");
        assert.equal((body.get("audio") as Blob).size, 7);
        requests.push(this);
      }
    }
    const old = Object.getOwnPropertyDescriptor(globalThis, "XMLHttpRequest");
    Object.defineProperty(globalThis, "XMLHttpRequest", { configurable: true, value: FakeXhr });
    t.after(() => { if (old) Object.defineProperty(globalThis, "XMLHttpRequest", old); else Reflect.deleteProperty(globalThis, "XMLHttpRequest"); setCsrf(); });
    setCsrf("test-csrf");
    const progress: Array<number | null> = [];
    let completed = 0, settled = false;
    const options: VoiceUploadOptions = { onUploadProgress: value => progress.push(value), onUploadComplete: () => completed++ };
    const submit = () => route === "send"
      ? api.sendVoiceMessage("conversation-id", new Blob(["fixture"]), "test.wav", "same-recording-id", "retained text", "", [], options)
      : api.transcribeAudio(new Blob(["fixture"]), "test.wav", { draftText: "retained text", clientRecordingId: "same-recording-id", ...options });
    const result = submit().then(value => { settled = true; return value; });
    const xhr = requests[0];
    assert.equal(xhr.headers["X-CSRF-Token"], "test-csrf");
    assert.equal(xhr.withCredentials, true);
    assert.equal(xhr.timeout, 600_000);
    for (const [loaded, total, lengthComputable] of [[128, 512, true], [511, 512, true], [128, 512, false], [128, 0, true]] as const) {
      xhr.upload.onprogress!({ loaded, total, lengthComputable });
    }
    assert.deepEqual(progress, [0, 25, 99, null, null]);
    assert.equal(completed, 0);
    xhr.upload.onload!(); await Promise.resolve();
    assert.equal(progress.at(-1), 100);
    assert.equal(completed, 1);
    assert.equal(settled, false, "upload 100% must not accept the request before the server response");
    xhr.status = 503; xhr.responseText = JSON.stringify({ error: "server unavailable" }); xhr.onload!();
    await assert.rejects(result, error => error instanceof ApiError && error.status === 503);
    assert.equal(requests.length, 1, "no automatic resend");
    const retry = submit();
    assert.equal(progress.at(-1), 0, "explicit retry restarts progress");
    const response = route === "send" ? { accepted: true, pendingPrompt: null } : { text: "recognized", transcriptionId: "test-id" };
    requests[1].status = route === "send" ? 202 : 200;
    requests[1].responseText = JSON.stringify(response); requests[1].onload!();
    assert.deepEqual(await retry, response);
    for (const event of ["onerror", "ontimeout", "onabort"] as const) {
      const failed = submit(); requests.at(-1)![event]!();
      await assert.rejects(failed, /录音已保留/);
    }
  });
}
