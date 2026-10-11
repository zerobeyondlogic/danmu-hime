'use strict';

const { TextDecoder } = require('util');
const { normalizeUrl } = require('../js/avatars.js');

const MAX_PROTO_BYTES = 64 * 1024;
const MAX_NAME_LENGTH = 80;
const utf8 = new TextDecoder('utf-8', { fatal: true });

function normalizeIdentity(uid, uname) {
  if (typeof uid !== 'number' && (typeof uid !== 'string' || !/^\d{1,16}$/.test(uid))) return null;
  const id = Number(uid);
  if (!Number.isSafeInteger(id) || id <= 0 || typeof uname !== 'string') return null;
  const name = Array.from(uname.slice(0, 1024)
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ')
    .replace(/\s+/g, ' ').trim()).slice(0, MAX_NAME_LENGTH).join('');
  return name ? { uid: id, uname: name } : null;
}

// Public protocol schema, verified at blivedm commit 3bf17fe:
// https://github.com/xfgryujk/blivedm/blob/3bf17fe862b8c2fc6bc04c81c3f0c5db95de93d6/blivedm/models/pb.py#L33
// uid = 1, uname = 2, msg_type = 5 (1 = enter; 2 = follow; 3 = share).
// uinfo = 22, uinfo.base = 2, uinfo.base.face = 2 (pb.py#L23-L40).
// models/web.py#L611 confirms that INTERACT_WORD_V2 data.pb is base64 protobuf.
// Read each bounded message once. Unknown nested fields remain opaque bytes.
function readProtoFields(bytes, visit) {
  let offset = 0;

  function varint() {
    let result = 0n;
    for (let i = 0; i < 10; i += 1) {
      if (offset >= bytes.length) throw new Error('Truncated varint');
      const byte = bytes[offset++];
      if (i === 9 && byte > 1) throw new Error('Varint overflow');
      result |= BigInt(byte & 0x7f) << BigInt(i * 7);
      if (byte < 0x80) return result;
    }
    throw new Error('Invalid varint');
  }

  function skip(length) {
    if (length > bytes.length - offset) throw new Error('Truncated field');
    offset += length;
  }

  while (offset < bytes.length) {
    const tag = varint();
    if (tag > 0xffffffffn || tag < 8n) throw new Error('Invalid tag');
    const field = Number(tag >> 3n);
    const wire = Number(tag & 7n);
    let value = null;
    if (wire === 0) value = varint();
    else if (wire === 2) {
      const size = varint();
      if (size > BigInt(bytes.length - offset)) throw new Error('Truncated field');
      const length = Number(size);
      value = bytes.subarray(offset, offset + length);
      skip(length);
    } else if (wire === 1) skip(8);
    else if (wire === 5) skip(4);
    else throw new Error('Invalid wire type');
    visit(field, wire, value);
  }
}

function decodeUserAvatar(bytes) {
  try {
    let face = '';
    readProtoFields(bytes, (field, wire, base) => {
      if (field !== 2 || wire !== 2) return;
      readProtoFields(base, (baseField, baseWire, text) => {
        if (baseField === 2 && baseWire === 2) {
          face = text.length <= 2048 ? utf8.decode(text) : '';
        }
      });
    });
    const normalized = normalizeUrl(face);
    if (!normalized) return '';
    const url = new URL(normalized);
    return !url.username && !url.password &&
      (url.hostname.endsWith('.hdslb.com') || url.hostname.endsWith('.bilibili.com')) ? url.href : '';
  } catch (_) {
    // Bad optional artwork must not discard an otherwise valid room arrival.
    return '';
  }
}

function decodeInteractWordV2(value) {
  if (typeof value !== 'string' || !value || value.length > Math.ceil(MAX_PROTO_BYTES / 3) * 4) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 === 1 ||
      (value.includes('=') && value.length % 4 !== 0)) return null;
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length > MAX_PROTO_BYTES || bytes.toString('base64').replace(/=+$/, '') !== value.replace(/=+$/, '')) return null;
  try {
    let uid = 0;
    let uname = '';
    let msgType = 0;
    let avatarUrl = '';
    readProtoFields(bytes, (field, wire, data) => {
      if (field === 1 || field === 5) {
        if (wire !== 0 || data > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Invalid identity field');
        if (field === 1) uid = Number(data);
        else msgType = Number(data);
      } else if (field === 2) {
        if (wire !== 2) throw new Error('Invalid name field');
        uname = utf8.decode(data);
      } else if (field === 22 && wire === 2) avatarUrl = decodeUserAvatar(data);
    });
    const identity = msgType === 1 ? normalizeIdentity(uid, uname) : null;
    return identity && avatarUrl ? { ...identity, avatarUrl } : identity;
  } catch (e) {
    return null;
  }
}

function normalizeEntryCommand(obj) {
  if (!obj || typeof obj !== 'object' || typeof obj.cmd !== 'string') return null;
  const cmd = obj.cmd.split(':')[0];
  const data = obj.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  if (cmd === 'INTERACT_WORD') {
    return data.msg_type === 1 || data.msg_type === '1' ? normalizeIdentity(data.uid, data.uname) : null;
  }
  if (cmd === 'INTERACT_WORD_V2') return decodeInteractWordV2(data.pb);
  // Other welcome/effect packets can lack a reliable plain username. Do not
  // infer entry events from their display copy or unrelated interaction types.
  return null;
}

module.exports = { normalizeEntryCommand };
