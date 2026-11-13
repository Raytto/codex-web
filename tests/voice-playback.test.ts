import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {VoicePlaybackEvidence} from '../server/voice-playback.js';
test('only exact timed PCM plus individual browser consumption proves playback',()=>{
 const p=new VoicePlaybackEvidence(),bytes=crypto.randomBytes(9600);
 p.sent(1,bytes.subarray(0,4800));p.sent(2,bytes.subarray(4800));p.reflected(bytes,1000,1200);
 assert.deepEqual(p.ranges,[]);p.played(2);assert.deepEqual(p.ranges,[[1100,1200]]);
 p.played(1);assert.deepEqual(p.ranges,[[1000,1200]]);p.played(1);assert.equal(p.ranges.length,1);
 p.sent(3,crypto.randomBytes(4800));p.played(3);assert.deepEqual(p.ranges,[[1000,1200]]);
});
test('late sideband catches up, invalid timing and repeated silence do not invent evidence',()=>{
 const p=new VoicePlaybackEvidence(),bytes=crypto.randomBytes(4800);p.sent(1,bytes);p.played(1);
 p.reflected(bytes,1000,2000);assert.deepEqual(p.ranges,[]);p.reflected(bytes,1000,1100);assert.deepEqual(p.ranges,[[1000,1100]]);
 const silence=Buffer.alloc(4800);p.sent(2,silence);p.reflected(silence,1200,1300);p.played(2);assert.deepEqual(p.ranges,[[1000,1100]]);
});
test('media epoch proves audible output only after exact browser consumption, not exact words',()=>{
 const p=new VoicePlaybackEvidence(),bytes=crypto.randomBytes(4800);p.sent(1,bytes,2);assert.equal(p.heardEpochs.size,0);
 p.played(1);assert.deepEqual([...p.heardEpochs],[2]);assert.deepEqual(p.ranges,[]);
 p.sent(2,Buffer.alloc(4800),3);p.played(2);assert.deepEqual([...p.heardEpochs],[2]);
});
