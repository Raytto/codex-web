import assert from "node:assert/strict";
import test from "node:test";
import { conversationLocation, readConversationLocation } from "../src/conversation-location.js";

test("conversation URLs preserve unrelated query/hash and distinguish missing from invalid links", () => {
  const id = "12345678-1234-4123-8123-123456789abc";
  const url = conversationLocation("https://example.test/app/?mode=wide#section", id);
  assert.equal(url, `https://example.test/app/?mode=wide&conversation=${id}#section`);
  assert.deepEqual(readConversationLocation(url), { explicit: true, id });
  assert.deepEqual(readConversationLocation(url.replace(id, id.toUpperCase())), { explicit: true, id });
  assert.equal(conversationLocation(url, null), "https://example.test/app/?mode=wide#section");
  assert.deepEqual(readConversationLocation("https://example.test/"), { explicit: false, id: null });
  for (const value of ["", "../private", "https://other.test/", "<script>", "bad-id"]) {
    assert.deepEqual(readConversationLocation(`https://example.test/?conversation=${encodeURIComponent(value)}`), { explicit: true, id: null });
  }
});
