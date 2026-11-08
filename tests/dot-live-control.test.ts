import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { DotCall } from '../server/dot-live.js';

function fixture() {
    const browser = new EventEmitter(), sent: any[] = [], upstream: any[] = [];
    const call = new DotCall({scope:()=>({fragment:()=>true})} as any, {} as any, browser as any);
    call.send = event => { sent.push(event); };
    call.up = event => { upstream.push(event); };
    return { call, sent, upstream, receive: (msg: unknown) => browser.emit('message', JSON.stringify(msg)), event: (msg: any) => (call as any).event(msg) };
}

test('stop suppresses old audio; next real speech explicitly restores upstream and local output once', () => {
    const f = fixture();
    f.receive({ type: 'stop_audio' });
    f.event({ type: 'session.output_audio.delta', delta: 'old' });
    f.event({ type: 'session.input_transcript.delta', delta: ' ' });
    assert.equal(f.sent.filter(e => e.type === 'audio').length, 0);
    assert.equal(f.upstream.length, 1);
    f.event({ type: 'session.input_transcript.delta', delta: 'Please' });
    f.event({ type: 'session.input_transcript.delta', delta: ' say five' });
    f.event({ type: 'session.output_audio.delta', delta: 'new' });
    assert.deepEqual(f.sent.filter(e => e.type === 'audio').map(e => e.delta), ['new']);
    assert.equal(f.upstream.length, 2);
    assert.match(f.upstream[1].content, /正常回答/);
    assert.notEqual(f.upstream[0].event_id, f.upstream[1].event_id);
});

test('repeated stop stays idempotent, and a second stop/resume cycle still works', () => {
    const f = fixture();
    f.receive({ type: 'stop_audio' }); f.receive({ type: 'stop_audio' });
    assert.equal(f.upstream.length, 1);
    f.event({ type: 'session.input_transcript.delta', delta: 'hello' });
    f.receive({ type: 'stop_audio' });
    f.event({ type: 'session.output_audio.delta', delta: 'old' });
    f.event({ type: 'session.input_transcript.delta', delta: 'again' });
    f.event({ type: 'session.output_audio.delta', delta: 'new' });
    assert.equal(f.upstream.length, 4);
    assert.deepEqual(f.sent.filter(e => e.type === 'audio').map(e => e.delta), ['new']);
    assert.equal(f.sent.filter(e => e.type === 'clear_audio').length, 3);
});

test('ordinary input fragments do not clear playback or append control instructions', () => {
    const f = fixture();
    for (const delta of ['Hello', ' there']) f.event({ type: 'session.input_transcript.delta', delta });
    assert.deepEqual(f.upstream, []);
    assert.equal(f.sent.filter(e => e.type === 'clear_audio').length, 0);
});
