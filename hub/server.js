// comfyaim hub: one chat room over WebSocket. No dependencies.
//
//   node hub/server.js            listens on 127.0.0.1:8095, data in hub/data
//   PORT=8095 HOST=127.0.0.1 DATA=/var/lib/comfyaim ADMINS=aloof,other node hub/server.js
//
// It is meant to sit behind nginx, which ends TLS. X-Real-IP is trusted only from a loopback peer.
//
// Wire format: one text frame is one line, fields split by a tab. A field never holds a tab or a
// newline; the hub strips both from anything a client sends.
//
//   client to hub                      hub to client
//   HELLO  nick  secret  version  realm    WELCOME  nick  count
//   SAY    text                              HIST     ts  nick  text  realm   (the backlog, oldest first)
//   WHO                                      MSG      ts  nick  text  realm
//   ADMIN  kick|ban|unban  nick              JOIN     nick  realm
//                                            PART     nick
//                                            WHO      nick  realm  nick  realm  ...
//
// realm is the name of the realm the player is logged in to, as the client reports it, and may be
// empty. A second HELLO on the same socket renames, or with the same nick only updates the realm.
// New fields go on the END of a line, so an older client reading by position keeps working.
//                                      SYS      text
//                                      ERR      code  text
//
// ERR codes: nick, taken, proto, muted, rate, admin; and three that come before the hub closes the
// socket: banned, kicked, replaced (the same secret signed on from another client).
//
// A nick belongs to whoever first used it, proven by a secret the client keeps. The hub stores only
// sha256(secret). One secret holds one nick: taking a new one lets the old one go. A nick nobody has
// used for NICK_DAYS is free again.
'use strict';
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 8095);
const HOST = process.env.HOST || '127.0.0.1';
const DATA = process.env.DATA || path.join(__dirname, 'data');
const ADMINS = new Set((process.env.ADMINS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean));

const MAX_TEXT = 255;          // bytes, the client's own chat limit
const MAX_FRAME = 4096;        // a client frame bigger than this closes the connection
const BACKLOG = 100;           // lines sent on joining, and kept in backlog.json
const RATE_LINES = 5;          // at most this many lines...
const RATE_WINDOW = 10000;     // ...in this many ms...
const MUTE_MS = 30000;         // ...or this long muted
const PER_IP = 4;              // open connections from one address
const HELLO_MS = 15000;        // time to say HELLO after connecting
const HELLO_TRIES = 10;        // bad HELLOs before the connection is closed
const PING_MS = 30000;
const DEAD_MS = 90000;         // nothing heard for this long: dropped
const NICK_DAYS = 90;
const LOG_MAX = 10 * 1024 * 1024;
const RESERVED = new Set(['system', 'admin', 'hub', 'comfyaim', 'aim', 'server', 'local']);

fs.mkdirSync(DATA, { recursive: true });
const NICKS_FILE = path.join(DATA, 'nicks.json');
const BANS_FILE = path.join(DATA, 'bans.json');
const ROOM_LOG = path.join(DATA, 'room.log');
const BACKLOG_FILE = path.join(DATA, 'backlog.json');

function readJson(file, dflt) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return dflt; }
}
function writeJson(file, value) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 1));
  fs.renameSync(tmp, file);
}

// nicks: lower-case nick -> { nick, hash, seen }
let nicks = readJson(NICKS_FILE, {});
// bans: { hashes: { hash: { nick, ip, at } }, ips: { ip: { nick, at } } }. Edit the file by hand and the
// hub picks it up.
let bans = readJson(BANS_FILE, { hashes: {}, ips: {} });
fs.watchFile(BANS_FILE, { interval: 5000 }, (cur, prev) => {
  if (cur.mtimeMs === prev.mtimeMs) return;   // the first poll of a missing file
  bans = readJson(BANS_FILE, bans);
  log('bans reloaded');
});

function expireNicks() {
  const cutoff = Date.now() - NICK_DAYS * 86400000;
  let n = 0;
  for (const k of Object.keys(nicks)) if (nicks[k].seen < cutoff) { delete nicks[k]; n++; }
  if (n) { writeJson(NICKS_FILE, nicks); log('released ' + n + ' unused nicks'); }
}
expireNicks();
setInterval(expireNicks, 86400000).unref();

let nicksDirty = false;
setInterval(() => { if (nicksDirty) { nicksDirty = false; writeJson(NICKS_FILE, nicks); } }, 60000).unref();

function log(text) {
  console.log(new Date().toISOString() + ' ' + text);
}

// The room log is for moderation: who said what, from where.
function roomLog(c, text) {
  try {
    if (fs.existsSync(ROOM_LOG) && fs.statSync(ROOM_LOG).size > LOG_MAX) fs.renameSync(ROOM_LOG, ROOM_LOG + '.1');
    fs.appendFileSync(ROOM_LOG, new Date().toISOString() + '\t' + c.ip + '\t' + c.nick + '\t' + text + '\n');
  } catch (e) {
    log('room log: ' + e.message);
  }
}

const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');

// Tabs, newlines and other control characters out, then cut to MAX_TEXT bytes on a character boundary.
function clean(text) {
  let s = String(text).replace(/[\x00-\x1f\x7f]/g, ' ').trim();
  let b = Buffer.from(s, 'utf8');
  if (b.length > MAX_TEXT) {
    let end = MAX_TEXT;
    while (end > 0 && (b[end] & 0xc0) === 0x80) end--;
    s = b.subarray(0, end).toString('utf8');
  }
  return s;
}

const validNick = n => /^[A-Za-z0-9_]{2,16}$/.test(n) && !RESERVED.has(n.toLowerCase());

// ------------------------------------------------------------------------------------------------
// the room

const clients = new Set();      // every open socket
const online = new Map();       // lower-case nick -> client
// [ts, nick, text, realm]. Saved, so a restart (every deploy is one) does not empty the room's history.
const backlog = (() => {
  const saved = readJson(BACKLOG_FILE, []);
  return Array.isArray(saved) ? saved.filter(l => Array.isArray(l) && l.length >= 3).slice(-BACKLOG) : [];
})();
let backlogDirty = false;
setInterval(() => { if (backlogDirty) { backlogDirty = false; writeJson(BACKLOG_FILE, backlog); } }, 10000).unref();

function send(c, ...fields) {
  if (c.open) c.sock.write(frame(0x1, Buffer.from(fields.join('\t'), 'utf8')));
}
function broadcast(...fields) {
  for (const c of online.values()) send(c, ...fields);
}
function who() {
  const list = [...online.values()].sort((a, b) => a.nick.toLowerCase() < b.nick.toLowerCase() ? -1 : 1);
  return list.flatMap(c => [c.nick, c.realm]);
}

function leave(c, why) {
  if (!c.nick || online.get(c.nick.toLowerCase()) !== c) return;
  online.delete(c.nick.toLowerCase());
  broadcast('PART', c.nick);
  log('part ' + c.nick + ' (' + why + ')');
}

function hello(c, nick, secret, version, realm) {
  if (++c.helloTries > HELLO_TRIES) return close(c, 'too many HELLOs');
  realm = clean(realm || '').slice(0, 32);
  if (!validNick(nick)) return send(c, 'ERR', 'nick', 'A nick is 2 to 16 letters, digits or _.');
  if (!/^[0-9a-f]{32,128}$/.test(secret)) return send(c, 'ERR', 'proto', 'Bad secret.');
  const hash = sha256(secret);
  if (bans.hashes[hash] || bans.ips[c.ip]) {
    send(c, 'ERR', 'banned', 'You are banned from this hub.');
    return close(c, 'banned');
  }
  const key = nick.toLowerCase();
  const owner = nicks[key];
  if (owner && owner.hash !== hash) return send(c, 'ERR', 'taken', 'The nick ' + owner.nick + ' belongs to somebody else.');

  // One nick per secret: taking a new one lets the old one go.
  for (const k of Object.keys(nicks)) if (k !== key && nicks[k].hash === hash) delete nicks[k];
  nicks[key] = { nick, hash, seen: Date.now() };
  nicksDirty = true;

  // The same person from a second window, or reconnecting before the old socket timed out.
  const prev = online.get(key);
  if (prev && prev !== c) {
    send(prev, 'ERR', 'replaced', 'Signed on from another client.');
    prev.nick = null;
    close(prev, 'replaced');
  }
  const renamed = c.nick && c.nick !== nick;
  if (renamed) leave(c, 'renamed to ' + nick);

  const first = !c.nick || renamed;
  const realmChanged = c.realm !== realm;
  c.nick = nick;
  c.hash = hash;
  c.realm = realm;
  c.version = String(version || '');
  c.helloTries = 0;
  online.set(key, c);
  if (first) {
    send(c, 'WELCOME', nick, String(online.size));
    for (const [ts, n, t, r] of backlog) send(c, 'HIST', String(ts), n, t, r);
    send(c, 'WHO', ...who());
  }
  // Everybody else learns the nick, or its new realm.
  if (first || realmChanged)
    for (const o of online.values()) if (o !== c) send(o, 'JOIN', nick, realm);
  if (first) log('join ' + nick + (realm ? ' on ' + realm : '') + ' from ' + c.ip + ' (' + c.version + ')');
}

function say(c, text) {
  if (!c.nick) return send(c, 'ERR', 'proto', 'Say HELLO first.');
  const now = Date.now();
  if (now < c.mutedUntil) return send(c, 'ERR', 'muted', 'Muted for ' + Math.ceil((c.mutedUntil - now) / 1000) + ' s.');
  c.said = c.said.filter(t => now - t < RATE_WINDOW);
  if (c.said.length >= RATE_LINES) {
    c.mutedUntil = now + MUTE_MS;
    return send(c, 'ERR', 'rate', 'Too fast. Muted for ' + MUTE_MS / 1000 + ' s.');
  }
  text = clean(text);
  if (!text) return;
  c.said.push(now);
  const ts = Math.floor(now / 1000);
  backlog.push([ts, c.nick, text, c.realm]);
  if (backlog.length > BACKLOG) backlog.shift();
  backlogDirty = true;
  roomLog(c, text);
  broadcast('MSG', String(ts), c.nick, text, c.realm);
}

function admin(c, verb, target) {
  if (!c.nick || !ADMINS.has(c.nick.toLowerCase())) return send(c, 'ERR', 'admin', 'Not an admin.');
  const key = String(target || '').toLowerCase();
  const t = online.get(key);
  const owner = nicks[key];
  if (verb === 'kick') {
    if (!t) return send(c, 'ERR', 'admin', target + ' is not online.');
    send(t, 'ERR', 'kicked', 'Kicked by ' + c.nick + '.');
    close(t, 'kicked by ' + c.nick);
    return send(c, 'SYS', 'Kicked ' + t.nick + '.');
  }
  if (verb === 'ban') {
    const hash = t ? t.hash : owner && owner.hash;
    if (!hash) return send(c, 'ERR', 'admin', 'No nick ' + target + '.');
    bans.hashes[hash] = { nick: target, ip: t ? t.ip : null, at: Date.now() };
    if (t) bans.ips[t.ip] = { nick: t.nick, at: Date.now() };
    writeJson(BANS_FILE, bans);
    if (t) { send(t, 'ERR', 'banned', 'Banned by ' + c.nick + '.'); close(t, 'banned by ' + c.nick); }
    log('ban ' + target + ' by ' + c.nick);
    return send(c, 'SYS', 'Banned ' + target + '.');
  }
  if (verb === 'unban') {
    let n = 0;
    for (const h of Object.keys(bans.hashes)) if (String(bans.hashes[h].nick).toLowerCase() === key) { delete bans.hashes[h]; n++; }
    for (const ip of Object.keys(bans.ips)) if (String(bans.ips[ip].nick).toLowerCase() === key) { delete bans.ips[ip]; n++; }
    writeJson(BANS_FILE, bans);
    log('unban ' + target + ' by ' + c.nick);
    return send(c, 'SYS', n ? 'Unbanned ' + target + '.' : 'No ban for ' + target + '.');
  }
  send(c, 'ERR', 'admin', 'kick, ban or unban.');
}

function onLine(c, line) {
  const f = line.split('\t');
  switch (f[0]) {
    case 'HELLO': return hello(c, f[1] || '', f[2] || '', f[3], f[4]);
    case 'SAY': return say(c, f.slice(1).join(' '));
    case 'WHO': return c.nick ? send(c, 'WHO', ...who()) : undefined;
    case 'ADMIN': return admin(c, f[1], f[2]);
    default: return send(c, 'ERR', 'proto', 'Unknown line.');
  }
}

// ------------------------------------------------------------------------------------------------
// WebSocket (RFC 6455): text frames, ping and pong, close. Client frames are always masked.

function frame(op, body) {
  let head;
  if (body.length < 126) head = Buffer.from([0x80 | op, body.length]);
  else if (body.length < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | op; head[1] = 126; head.writeUInt16BE(body.length, 2); }
  else { head = Buffer.alloc(10); head[0] = 0x80 | op; head[1] = 127; head.writeBigUInt64BE(BigInt(body.length), 2); }
  return Buffer.concat([head, body]);
}

function close(c, why) {
  if (!c.open) return;
  c.open = false;
  try { c.sock.end(frame(0x8, Buffer.alloc(0))); } catch { /* already gone */ }
  setTimeout(() => c.sock.destroy(), 1000).unref();
  cleanup(c, why);
}

function cleanup(c, why) {
  if (!clients.delete(c)) return;
  c.open = false;
  clearTimeout(c.helloTimer);
  leave(c, why);
}

function peerIp(req) {
  const peer = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  if (peer === '127.0.0.1' || peer === '::1') return String(req.headers['x-real-ip'] || peer);
  return peer;
}

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('comfyaim hub: ' + online.size + ' online\n');
});

server.on('upgrade', (req, sock) => {
  const key = req.headers['sec-websocket-key'];
  if (!key || (req.headers.upgrade || '').toLowerCase() !== 'websocket') { sock.destroy(); return; }
  const ip = peerIp(req);
  let fromIp = 0;
  for (const o of clients) if (o.ip === ip) fromIp++;
  if (fromIp >= PER_IP) {
    sock.end('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n');
    return;
  }
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
             'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  sock.setNoDelay(true);

  const c = { sock, ip, open: true, nick: null, hash: null, version: '', realm: '', said: [], mutedUntil: 0,
              helloTries: 0, heard: Date.now(), buf: Buffer.alloc(0), parts: [] };
  clients.add(c);
  c.helloTimer = setTimeout(() => { if (!c.nick) close(c, 'no HELLO'); }, HELLO_MS);

  sock.on('data', chunk => {
    c.heard = Date.now();
    c.buf = Buffer.concat([c.buf, chunk]);
    while (c.open) {
      const b = c.buf;
      if (b.length < 2) return;
      const fin = b[0] & 0x80, op = b[0] & 0x0f, masked = b[1] & 0x80;
      let len = b[1] & 0x7f, at = 2;
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); at = 4; }
      else if (len === 127) { if (b.length < 10) return; len = Number(b.readBigUInt64BE(2)); at = 10; }
      if (!masked || len > MAX_FRAME) return close(c, 'bad frame');
      if (b.length < at + 4 + len) return;
      const mask = b.subarray(at, at + 4);
      const data = Buffer.from(b.subarray(at + 4, at + 4 + len));
      c.buf = b.subarray(at + 4 + len);
      for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3];

      if (op === 0x8) return close(c, 'closed by client');
      if (op === 0x9) { sock.write(frame(0xa, data)); continue; }
      if (op === 0xa) continue;
      if (op === 0x1 || op === 0x2) c.parts = [data];
      else if (op === 0x0) c.parts.push(data);
      else return close(c, 'bad opcode');
      if (c.parts.reduce((n, p) => n + p.length, 0) > MAX_FRAME) return close(c, 'message too big');
      if (!fin) continue;
      const line = Buffer.concat(c.parts).toString('utf8');
      c.parts = [];
      onLine(c, line);
    }
  });
  sock.on('close', () => cleanup(c, 'disconnected'));
  sock.on('error', () => cleanup(c, 'socket error'));
});

setInterval(() => {
  const now = Date.now();
  for (const c of clients) {
    if (now - c.heard > DEAD_MS) close(c, 'timed out');
    else if (c.open) c.sock.write(frame(0x9, Buffer.alloc(0)));
  }
}, PING_MS).unref();

function shutdown() {
  if (nicksDirty) writeJson(NICKS_FILE, nicks);
  if (backlogDirty) writeJson(BACKLOG_FILE, backlog);
  for (const c of clients) { send(c, 'SYS', 'The hub is restarting.'); close(c, 'shutdown'); }
  server.close();
  setTimeout(() => process.exit(0), 500);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.listen(PORT, HOST, () => log('comfyaim hub on ' + HOST + ':' + PORT + ', data in ' + DATA +
  (ADMINS.size ? ', admins ' + [...ADMINS].join(',') : ', no admins')));
