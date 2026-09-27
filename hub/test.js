// Checks a running hub from the outside. Start one on a spare port with a throwaway data folder:
//   PORT=8096 DATA=%TEMP%/aimtest ADMINS=adminnick node hub/server.js
//   node hub/test.js ws://127.0.0.1:8096/aim
'use strict';
const crypto = require('crypto');

const URL = process.argv[2] || 'ws://127.0.0.1:8096/aim';
const secret = () => crypto.randomBytes(16).toString('hex');
let failed = 0;

function check(ok, what) {
  console.log((ok ? 'ok   ' : 'FAIL ') + what);
  if (!ok) failed++;
}

// A client that keeps every line it gets, and can wait for one that matches.
function client() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    const c = { ws, lines: [], waiters: [] };
    ws.onmessage = e => {
      c.lines.push(e.data);
      c.waiters = c.waiters.filter(w => !(w.re.test(e.data) && (w.resolve(e.data), true)));
    };
    c.send = (...f) => ws.send(f.join('\t'));
    c.wait = (re, ms = 2000) => {
      const hit = c.lines.find(l => re.test(l));
      if (hit) { c.lines.splice(c.lines.indexOf(hit), 1); return Promise.resolve(hit); }
      return new Promise(res => {
        const w = { re, resolve: l => { c.lines.splice(c.lines.indexOf(l), 1); res(l); } };
        c.waiters.push(w);
        setTimeout(() => { c.waiters = c.waiters.filter(x => x !== w); res(null); }, ms);
      });
    };
    ws.onopen = () => resolve(c);
    ws.onerror = reject;
  });
}

(async () => {
  const run = Date.now().toString(36).slice(-5);
  const nickA = 'Alice' + run, nickB = 'Bob' + run;
  const sa = secret(), sb = secret();

  const a = await client();
  a.send('HELLO', nickA, sa, 'test');
  check(/^WELCOME\t/.test(await a.wait(/^WELCOME/)), 'A is welcomed');

  const b = await client();
  b.send('HELLO', nickA, sb, 'test');
  check(/^ERR\ttaken/.test(await b.wait(/^ERR/)), 'B cannot take A\'s nick');
  b.send('HELLO', 'x', sb, 'test');
  check(/^ERR\tnick/.test(await b.wait(/^ERR/)), 'a one-letter nick is refused');
  b.send('HELLO', nickB, sb, 'test');
  check(!!await b.wait(/^WELCOME/), 'B is welcomed under its own nick');
  check(!!await a.wait(new RegExp('^JOIN\\t' + nickB + '\\t')), 'A sees B join');
  const w = await b.wait(/^WHO/);
  check(w && w.split('\t').includes(nickA) && w.split('\t').includes(nickB), 'WHO lists both');

  b.send('HELLO', nickB, sb, 'test', 'Nordanaar');
  check(!!await a.wait(new RegExp('^JOIN\\t' + nickB + '\\tNordanaar$')), 'a realm change reaches the others as JOIN');
  check(!b.lines.some(l => /^WELCOME/.test(l)), 'the same nick again is not a second WELCOME');

  a.send('SAY', 'hello |cffff0000red|r\x01');
  const m = await b.wait(/^MSG/);
  check(m && m.split('\t')[2] === nickA, 'B gets A\'s line');
  check(m && m.split('\t')[3] === 'hello |cffff0000red|r', 'control characters stripped, pipes left for the addon');
  a.send('HELLO', nickA, sa, 'test', 'ComfyCraft');
  a.send('SAY', 'from a realm');
  const mr = await b.wait(/^MSG\t\d+\t\w+\tfrom a realm/);
  check(mr && mr.split('\t')[4] === 'ComfyCraft', 'MSG carries the realm at the end');

  // A login address in servers.txt shows as the tag, and the address itself goes to nobody.
  a.send('HELLO', nickA, sa, 'test', 'Brill', 'comfycraft.dedyn.io:3724');
  check(!!await b.wait(new RegExp('^JOIN\\t' + nickA + '\\tCOMFY$')), 'a listed address shows as its tag');
  a.send('HELLO', nickA, sa, 'test', 'Brill', '192.168.1.20');
  check(!!await b.wait(new RegExp('^JOIN\\t' + nickA + '\\tBrill$')), 'an unlisted address falls back to the realm name');
  check(!b.lines.concat(a.lines).some(l => /dedyn|192\.168/.test(l)), 'no address is ever sent');

  const long = 'x'.repeat(400);
  a.send('SAY', long);
  const lm = await a.wait(/^MSG\t\d+\t\w+\tx/);
  check(lm && lm.split('\t')[3].length === 255, 'a long line is cut to 255 bytes');

  for (let i = 0; i < 6; i++) b.send('SAY', 'spam ' + i);
  check(/^ERR\trate/.test(await b.wait(/^ERR/)), 'the sixth line in 10 s mutes');
  b.send('SAY', 'still muted');
  check(/^ERR\tmuted/.test(await b.wait(/^ERR/)), 'a muted client is told so');

  // A second connection with A's secret replaces the first.
  const a2 = await client();
  a2.send('HELLO', nickA, sa, 'test');
  check(!!await a2.wait(/^WELCOME/), 'A signs on again from a second socket');
  check(!!await a.wait(/^ERR\treplaced/), 'the old socket is told and closed');
  check(!!await a2.wait(/^HIST/), 'the new socket gets the backlog');

  // Renaming lets the old nick go.
  a2.send('HELLO', nickA + 'x', sa, 'test');
  check(!!await a2.wait(/^WELCOME/), 'A renames');
  check(!!await b.wait(new RegExp('^PART\\t' + nickA + '$')), 'B sees the old nick part');
  const c = await client();
  c.send('HELLO', nickA, secret(), 'test');
  check(!!await c.wait(/^WELCOME/), 'the old nick is free for somebody else');

  b.send('ADMIN', 'kick', nickA);
  check(/^ERR\tadmin/.test(await b.wait(/^ERR/)), 'a non-admin cannot kick');

  for (const x of [a2, b, c]) x.ws.close();
  console.log(failed ? failed + ' failed' : 'all passed');
  setTimeout(() => process.exit(failed ? 1 : 0), 200);
})();
