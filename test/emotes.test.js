'use strict';

const assert = require('assert');
const emotes = require('../js/emotes.js');

function testOfficialSingleEmote() {
  const flags = [];
  flags[13] = {
    url: 'http://i0.hdslb.com/bfs/live/sample.png',
    width: 162,
    height: 162
  };
  const info = [flags, '[UPOWER_366212145_好]'];
  const result = emotes.extractDanmakuEmotes({ cmd: 'DANMU_MSG', info }, info);
  assert.strictEqual(result['[UPOWER_366212145_好]'].url, 'https://i0.hdslb.com/bfs/live/sample.png');
  assert.strictEqual(result['[UPOWER_366212145_好]'].official, true);
}

function testNestedTextEmotesRemainSupported() {
  const info = [[], '你好[小电视]'];
  const obj = {
    info,
    data: {
      extra: JSON.stringify({
        emots: {
          '[小电视]': { url: '//i0.hdslb.com/bfs/live/tv.png', width: 40, height: 40 }
        }
      })
    }
  };
  const result = emotes.extractDanmakuEmotes(obj, info);
  assert.strictEqual(result['[小电视]'].url, 'https://i0.hdslb.com/bfs/live/tv.png');
}

function testUnsafeImageUrlIsRejected() {
  const flags = [];
  flags[13] = { url: 'https://example.com/tracker.png' };
  const info = [flags, '[bad]'];
  assert.deepStrictEqual(emotes.extractDanmakuEmotes({ info }, info), {});
}

function testRoomAliasesAreConservative() {
  const aliases = emotes.buildRoomEmoteAliases([{
    emoji: '问号',
    unique: 'room_1_2',
    url: 'https://i0.hdslb.com/bfs/live/question.png',
    width: 162,
    height: 162
  }]);
  assert.ok(aliases['[问号]']);
  assert.ok(aliases['room_1_2']);
  assert.ok(aliases['[room_1_2]']);
  assert.strictEqual(aliases['问号'], undefined, '普通文本不能被误替换为表情');
  assert.deepStrictEqual(Object.keys(emotes.mergeRoomEmotes('只是问号两个字', {}, aliases)), []);
  assert.ok(emotes.mergeRoomEmotes('这是[问号]', {}, aliases)['[问号]']);
}

testOfficialSingleEmote();
testNestedTextEmotesRemainSupported();
testUnsafeImageUrlIsRejected();
testRoomAliasesAreConservative();

{
  const root = { emots: { '[valid]': { url: 'https://i0.hdslb.com/valid.png' } } };
  let nested = root;
  for (let index = 0; index < 20000; index++) { nested.extra = {}; nested = nested.extra; }
  nested.extra = root;
  const result = emotes.extractDanmakuEmotes(root, [[], '[valid]']);
  assert.strictEqual(result['[valid]'].url, 'https://i0.hdslb.com/valid.png');
  assert.doesNotThrow(() => emotes.extractDanmakuEmotes({ extra: root }, []));
  assert.deepStrictEqual(emotes.extractDanmakuEmotes({ extra: '{' + ' '.repeat(70000) }, []), {});
}

{
  const map = JSON.parse('{"__proto__":{"url":"https://i0.hdslb.com/proto.png"},"constructor":{"url":"https://i0.hdslb.com/ctor.png"}}');
  for (let index = 0; index < 5000; index++) map['[' + index + ']'] = { url: 'https://i0.hdslb.com/emote.png' };
  const result = emotes.extractDanmakuEmotes({ emots: map }, []);
  assert.strictEqual(Object.getPrototypeOf(result), Object.prototype);
  assert.strictEqual(Object.hasOwn(result, 'constructor'), false);
  assert.ok(Object.keys(result).length <= 64);
  const aliases = emotes.buildRoomEmoteAliases(Array.from({ length: 5000 }, (_, index) => ({
    emoji: String(index), unique: 'unique_' + index, url: 'https://i0.hdslb.com/emote.png'
  })));
  assert.ok(Object.keys(aliases).length <= 2048);
  assert.ok(Object.keys(emotes.mergeRoomEmotes('[1]', map, aliases)).length <= 64);
  assert.strictEqual(emotes.safeEmoteUrl('https://user:password@i0.hdslb.com/emote.png'), '');
  assert.strictEqual(emotes.safeEmoteUrl('https://i0.hdslb.com/' + 'a'.repeat(2048)), '');
}
console.log('emotes tests passed');
