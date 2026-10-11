(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.BiliGiftEvents = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  // Final SEND_GIFT_V2 schema, including the corrected price field order:
  // https://github.com/xfgryujk/blivedm/commit/93530bcc20de8a67f8d0ee4788096da2480b8a10
  // sender_uinfo follows the official frontend schema quoted by its maintainer:
  // https://github.com/xfgryujk/blivedm/pull/86#issuecomment-5104705486
  const MAX_BYTES = 256 * 1024;
  const MAX_GIFTS = 128;
  const MAX_FIELDS = 8192;
  const MAX_STRING_BYTES = 8192;
  const utf8 = new TextDecoder('utf-8', { fatal: true });
  const integer = (name) => ({ name, wire: 0 });
  const string = (name) => ({ name, wire: 2, string: true });
  const nested = (name, schema, repeated = false) => ({ name, wire: 2, schema, repeated });
  const medalSchema = {
    1: integer('target_id'), 4: integer('anchor_roomid'),
    5: integer('medal_level'), 6: string('medal_name'), 12: integer('guard_level')
  };
  const blindSchema = {
    1: integer('blind_gift_config_id'), 2: integer('original_gift_id'),
    3: string('original_gift_name'), 5: string('gift_action'),
    6: integer('original_gift_price'), 7: integer('gift_tip_price')
  };
  const userMedalSchema = {
    1: string('name'), 2: integer('level'), 8: integer('typ'),
    10: integer('ruid'), 11: integer('guard_level')
  };
  const userSchema = {
    1: integer('uid'),
    2: nested('base', { 1: string('name'), 2: string('face'), 4: integer('is_mystery') }),
    3: nested('medal', userMedalSchema),
    6: nested('guard', { 1: integer('level') })
  };
  const giftSchema = {
    1: integer('giftId'), 2: string('giftName'), 3: integer('num'),
    4: integer('demarcation'), 5: integer('price'), 6: integer('discount_price'),
    7: integer('total_coin'), 8: string('coin_type'), 9: string('tid'),
    10: integer('timestamp'), 11: integer('super_batch_gift_num'),
    12: string('batch_combo_id'), 14: integer('combo_total_coin'),
    18: string('action'), 35: nested('gift_info', { 1: string('img_basic') }),
    36: integer('gift_tip_price')
  };
  const broadcastSchema = {
    1: integer('uid'), 2: string('uname'), 3: string('face'),
    5: integer('guard_level'), 8: nested('medal_info', medalSchema),
    9: nested('blind_gift', blindSchema), 10: nested('gift_list', giftSchema, true),
    15: nested('sender_uinfo', userSchema)
  };

  function decodeBase64(value) {
    if (typeof value !== 'string' || !value || value.length > Math.ceil(MAX_BYTES / 3) * 4 ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 === 1 ||
        (value.includes('=') && value.length % 4 !== 0)) throw new Error('Invalid base64');
    const binary = atob(value);
    if (binary.length > MAX_BYTES || btoa(binary).replace(/=+$/, '') !== value.replace(/=+$/, '')) {
      throw new Error('Invalid base64 bytes');
    }
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  }

  function parseMessage(bytes, schema, budget, depth = 0) {
    if (depth > 6) throw new Error('Gift nesting limit');
    let offset = 0;
    const result = {};
    function varint() {
      let value = 0n;
      for (let count = 0; count < 10; count += 1) {
        if (offset >= bytes.length) throw new Error('Truncated varint');
        const byte = bytes[offset++];
        if (count === 9 && byte > 1) throw new Error('Varint overflow');
        value |= BigInt(byte & 127) << BigInt(count * 7);
        if (byte < 128) return value;
      }
      throw new Error('Invalid varint');
    }
    function skip(size) {
      if (size > bytes.length - offset) throw new Error('Truncated field');
      offset += size;
    }
    while (offset < bytes.length) {
      if (--budget.fields < 0) throw new Error('Gift field limit');
      const tag = varint();
      if (tag < 8n || tag > 0xffffffffn) throw new Error('Invalid field tag');
      const field = Number(tag >> 3n);
      const wire = Number(tag & 7n);
      const spec = schema[field];
      if (spec && spec.wire !== wire) throw new Error('Invalid field type');
      let value;
      if (wire === 0) {
        const number = varint();
        if (spec) {
          if (number > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Unsafe gift integer');
          value = Number(number);
        }
      } else if (wire === 2) {
        const size = varint();
        if (size > BigInt(bytes.length - offset)) throw new Error('Truncated message');
        const length = Number(size);
        if (spec) {
          const chunk = bytes.subarray(offset, offset + length);
          if (spec.string) {
            if (length > MAX_STRING_BYTES) throw new Error('Gift string limit');
            value = utf8.decode(chunk);
          } else {
            if (spec.repeated && --budget.gifts < 0) throw new Error('Gift count limit');
            value = parseMessage(chunk, spec.schema, budget, depth + 1);
          }
        }
        skip(length);
      } else if (wire === 1) {
        skip(8);
      } else if (wire === 5) {
        skip(4);
      } else {
        throw new Error('Unsupported field type');
      }
      if (spec) {
        if (spec.repeated) {
          if (!result[spec.name]) result[spec.name] = [];
          result[spec.name].push(value);
        } else result[spec.name] = value;
      }
    }
    return result;
  }

  function expandGiftCommands(obj) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return [];
    if (typeof obj.cmd !== 'string' || obj.cmd.split(':')[0] !== 'SEND_GIFT_V2') return [obj];
    try {
      const data = obj.data;
      if (!data || typeof data !== 'object') return [];
      const broadcast = parseMessage(decodeBase64(data.pb), broadcastSchema,
        { fields: MAX_FIELDS, gifts: MAX_GIFTS });
      const sender = broadcast.sender_uinfo || {};
      const base = sender.base || {};
      const userMedal = sender.medal || {};
      const medal = broadcast.medal_info || (userMedal.name ? {
        medal_name: userMedal.name, medal_level: userMedal.level || 0,
        target_id: userMedal.ruid || 0, guard_level: userMedal.guard_level || 0
      } : undefined);
      const identity = {
        uid: sender.uid || broadcast.uid || 0,
        uname: base.name || broadcast.uname || '',
        face: base.face || broadcast.face || '',
        guard_level: broadcast.guard_level || (sender.guard && sender.guard.level) || 0,
        ...(medal ? { medal_info: medal } : {}),
        ...(broadcast.sender_uinfo ? { sender_uinfo: broadcast.sender_uinfo } : {}),
        ...(broadcast.blind_gift && Object.keys(broadcast.blind_gift).length
          ? { blind_gift: broadcast.blind_gift } : {})
      };
      // One broadcast can contain several different draws. Keep each item's
      // quantity and prices; combo totals are never a substitute for them.
      return (broadcast.gift_list || []).filter((gift) => Object.keys(gift).length).map((gift) => ({
        cmd: 'SEND_GIFT', data: { ...identity, ...gift }
      }));
    } catch (_) {
      // A malformed gift must not interrupt normal chat or the relay socket.
      return [];
    }
  }

  return Object.freeze({ expandGiftCommands });
});
