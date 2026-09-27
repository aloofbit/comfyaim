// discord.js: the room and one Discord channel, both ways. No dependencies.
//
//   DISCORD_TOKEN=<bot token> DISCORD_CHANNEL=<channel id> node hub/server.js
//
// Discord to the room: the bot keeps Discord's Gateway open and passes on every message posted in the
// channel by a person (not a bot, not a webhook). The hub shows it as "Name (DISCORD)".
// The room to Discord: every line said in the room is posted through a webhook in the channel, under the
// player's own name, "Luf (COMFY)". The bot finds a webhook called ComfyAIM in the channel, or makes one,
// so it needs Manage Webhooks there as well as View Channel, Send Messages and Read Message History, and
// the Message Content intent turned on in the Developer Portal.
//
// Node 18 has no WebSocket client, so this has a small one of its own (wsConnect) rather than asking the
// box for a newer Node, which the website also runs on.
'use strict';
const https = require('https');
const tls = require('tls');
const crypto = require('crypto');

const API = 'https://discord.com/api/v10';
const INTENTS = (1 << 9) | (1 << 15);   // GUILD_MESSAGES, MESSAGE_CONTENT
const HOOK_NAME = 'ComfyAIM';           // a webhook name may not contain "discord"

// ------------------------------------------------------------------------------------------------
// a WebSocket client over TLS: text frames, fragments, ping, close. Frames we send are masked.

function wsConnect(url, on) {
  const u = new URL(url);
  const sock = tls.connect({ host: u.hostname, port: Number(u.port) || 443, servername: u.hostname });
  const key = crypto.randomBytes(16).toString('base64');
  let open = false, buf = Buffer.alloc(0), parts = [], closed = false;

  function frame(op, body) {
    const mask = crypto.randomBytes(4);
    const len = body.length;
    let head;
    if (len < 126) head = Buffer.from([0x80 | op, 0x80 | len]);
    else if (len < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | op; head[1] = 0x80 | 126; head.writeUInt16BE(len, 2); }
    else { head = Buffer.alloc(10); head[0] = 0x80 | op; head[1] = 0x80 | 127; head.writeBigUInt64BE(BigInt(len), 2); }
    const masked = Buffer.from(body);
    for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i & 3];
    return Buffer.concat([head, mask, masked]);
  }

  function finish(code) {
    if (closed) return;
    closed = true;
    sock.destroy();
    on.close(code || 0);
  }

  sock.on('secureConnect', () => {
    sock.write('GET ' + u.pathname + u.search + ' HTTP/1.1\r\nHost: ' + u.host + '\r\nUpgrade: websocket\r\n' +
               'Connection: Upgrade\r\nSec-WebSocket-Key: ' + key + '\r\nSec-WebSocket-Version: 13\r\n\r\n');
  });
  sock.on('data', chunk => {
    buf = Buffer.concat([buf, chunk]);
    if (!open) {
      const end = buf.indexOf('\r\n\r\n');
      if (end < 0) return;
      const status = buf.subarray(0, end).toString().split('\r\n')[0];
      if (!/ 101 /.test(status)) return finish(-1);
      open = true;
      buf = buf.subarray(end + 4);
      on.open();
    }
    for (;;) {
      if (buf.length < 2) return;
      const fin = buf[0] & 0x80, op = buf[0] & 0x0f;
      let len = buf[1] & 0x7f, at = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); at = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); at = 10; }
      if (buf.length < at + len) return;
      const data = Buffer.from(buf.subarray(at, at + len));
      buf = buf.subarray(at + len);
      if (op === 0x8) return finish(data.length >= 2 ? data.readUInt16BE(0) : 0);
      if (op === 0x9) { sock.write(frame(0xa, data)); continue; }
      if (op === 0xa) continue;
      if (op === 0x1 || op === 0x2) parts = [data];
      else if (op === 0x0) parts.push(data);
      if (!fin) continue;
      const text = Buffer.concat(parts).toString('utf8');
      parts = [];
      on.message(text);
    }
  });
  sock.on('close', () => finish(0));
  sock.on('error', () => finish(0));

  return {
    send(text) { if (open && !closed) sock.write(frame(0x1, Buffer.from(text, 'utf8'))); },
    close(code) {
      if (closed) return;
      const b = Buffer.alloc(2);
      b.writeUInt16BE(code || 1000, 0);
      try { sock.write(frame(0x8, b)); } catch { /* gone */ }
      setTimeout(() => finish(code || 1000), 500);
    },
  };
}

// ------------------------------------------------------------------------------------------------
// the REST API, JSON both ways, waiting out a 429 as Discord asks

function request(method, path, body, auth) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const u = new URL(path.startsWith('http') ? path : API + path);
    const headers = { 'User-Agent': 'comfyaim (https://github.com/aloofbit/comfyaim, 0.1)' };
    if (auth) headers.Authorization = 'Bot ' + auth;
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = data.length; }
    const req = https.request(u, { method, headers, timeout: 15000 }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', d => { text += d; });
      res.on('end', () => {
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
        if (res.statusCode === 429) {
          const wait = Math.ceil(((json && json.retry_after) || 1) * 1000);
          return setTimeout(() => request(method, path, body, auth).then(resolve, reject), wait);
        }
        if (res.statusCode >= 400) return reject(new Error(method + ' ' + u.pathname + ': ' + res.statusCode + ' ' + text.slice(0, 200)));
        resolve(json);
      });
    });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// ------------------------------------------------------------------------------------------------
// text, both ways

// The game's escape codes, drawn the way the game shows them.
function plain(t) {
  return String(t || '')
    .replace(/\|c[0-9a-fA-F]{8}/g, '').replace(/\|r/g, '')
    .replace(/\|H[^|]*\|h(\[[^\]]*\])\|h/g, '$1')
    .replace(/\|\|/g, '|');
}

// Room text into Discord: Discord's formatting characters escaped, so a line shows as it was typed.
// Pings are stopped separately, by allowed_mentions on every post.
function toDiscord(t) {
  return plain(t).replace(/([\\*_~`|>#\-[\]()])/g, '\\$1').replace(/@/g, '@\u200b');
}

// A Discord message into room text: mentions and custom emoji as their names, pictures as a word.
function fromDiscord(d) {
  const names = {};
  for (const m of d.mentions || []) names[m.id] = (m.global_name || m.username);
  let t = String(d.content || '')
    .replace(/<@!?(\d+)>/g, (_, id) => '@' + (names[id] || 'someone'))
    .replace(/<@&\d+>/g, '@role')
    .replace(/<#\d+>/g, '#channel')
    .replace(/<a?:(\w+):\d+>/g, ':$1:')
    .replace(/[\r\n\t]+/g, ' ')
    .trim();
  if ((d.attachments || []).length) t += (t ? ' ' : '') + '[picture]';
  if ((d.sticker_items || []).length) t += (t ? ' ' : '') + '[sticker]';
  return t;
}

// ------------------------------------------------------------------------------------------------

module.exports = function startDiscord({ token, channel, log, onMessage }) {
  let hook = null;          // { id, token }
  let gw = null, seq = null, beat = null, acked = true, wait = 5000, stopped = false;
  const queue = [];
  let posting = false;

  async function findHook() {
    const hooks = await request('GET', '/channels/' + channel + '/webhooks', null, token);
    let h = (hooks || []).find(x => x.name === HOOK_NAME && x.token);
    if (!h) h = await request('POST', '/channels/' + channel + '/webhooks', { name: HOOK_NAME }, token);
    hook = { id: h.id, token: h.token };
    log('discord: posting through webhook ' + HOOK_NAME);
  }

  async function drain() {
    if (posting) return;
    posting = true;
    while (queue.length) {
      const item = queue.shift();
      try {
        if (!hook) await findHook();
        await request('POST', API + '/webhooks/' + hook.id + '/' + hook.token, item);
      } catch (e) {
        log('discord: post failed: ' + e.message);
        if (/ 404 /.test(e.message)) hook = null;    // the webhook was deleted: find or make it again
      }
    }
    posting = false;
  }

  // A room line into the channel, under the player's own name.
  function post(nick, where, text) {
    let username = where ? nick + ' (' + where + ')' : nick;
    if (/discord|clyde/i.test(username)) username = 'Player';
    const content = toDiscord(text);
    if (!content) return;
    queue.push({ username: username.slice(0, 80), content: content.slice(0, 2000), allowed_mentions: { parse: [] } });
    if (queue.length > 50) queue.shift();
    drain();
  }

  function heartbeat() {
    if (!acked) { log('discord: no heartbeat answer, reconnecting'); gw && gw.close(4000); return; }
    acked = false;
    gw.send(JSON.stringify({ op: 1, d: seq }));
  }

  async function connect() {
    if (stopped) return;
    let url;
    try {
      url = (await request('GET', '/gateway/bot', null, token)).url;
    } catch (e) {
      log('discord: ' + e.message);
      if (/ 401 /.test(e.message)) { stopped = true; return log('discord: the token was refused, the bridge is off'); }
      return setTimeout(connect, wait = Math.min(wait * 2, 300000));
    }
    gw = wsConnect(url + '/?v=10&encoding=json', {
      open() {},
      message(text) {
        let p;
        try { p = JSON.parse(text); } catch { return; }
        if (p.s != null) seq = p.s;
        if (p.op === 10) {
          acked = true;
          clearInterval(beat);
          beat = setInterval(heartbeat, p.d.heartbeat_interval);
          gw.send(JSON.stringify({ op: 2, d: { token, intents: INTENTS,
            properties: { os: 'linux', browser: 'comfyaim', device: 'comfyaim' } } }));
        } else if (p.op === 11) {
          acked = true;
        } else if (p.op === 1) {
          gw.send(JSON.stringify({ op: 1, d: seq }));
        } else if (p.op === 7 || p.op === 9) {
          gw.close(4000);
        } else if (p.op === 0 && p.t === 'READY') {
          wait = 5000;
          log('discord: signed on as ' + p.d.user.username + ', bridging channel ' + channel);
        } else if (p.op === 0 && p.t === 'MESSAGE_CREATE') {
          const d = p.d;
          if (d.channel_id !== channel || d.webhook_id || (d.author && d.author.bot)) return;
          const text = fromDiscord(d);
          if (!text) return;
          const name = (d.member && d.member.nick) || d.author.global_name || d.author.username;
          onMessage({ id: d.author.id, name, text });
        }
      },
      close(code) {
        clearInterval(beat);
        gw = null;
        if (code === 4004) { stopped = true; return log('discord: the token was refused, the bridge is off'); }
        if (code === 4014) { stopped = true; return log('discord: the Message Content intent is off in the Developer Portal, the bridge is off'); }
        if (stopped) return;
        log('discord: gateway closed (' + code + '), reconnecting in ' + wait / 1000 + ' s');
        setTimeout(connect, wait);
        wait = Math.min(wait * 2, 300000);
      },
    });
  }

  connect();
  findHook().catch(e => log('discord: webhook: ' + e.message));

  return {
    post,
    stop() { stopped = true; clearInterval(beat); if (gw) gw.close(1000); },
  };
};

module.exports.wsConnect = wsConnect;
module.exports.toDiscord = toDiscord;
module.exports.fromDiscord = fromDiscord;
