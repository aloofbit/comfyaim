// comfyaim web widget: the /a chat room on a web page. No dependencies.
//
//   <script src="https://comfycraft.dedyn.io/aim/widget.js" defer></script>
//       a floating AIM button in the corner of the page, which opens the room
//   <div id="aim"></div>
//   <script src="https://comfycraft.dedyn.io/aim/widget.js" data-mode="inline" data-target="#aim" defer></script>
//       the room drawn into that element, full size
//
// The room is found from the script's own address: served from https://host/aim/widget.js, it joins
// wss://host/aim. So the one line above is all a page needs. A page with a Content-Security-Policy
// must allow that host for script-src, style-src and connect-src.
//
// It speaks the same lines as the game's DLL (hub/server.js lists them). Who you are is a name and a
// secret the browser keeps in localStorage, so it is per site: the name you take here is yours here.
// Everything drawn from the room is set as text, never as HTML, and it all lives in a Shadow DOM so
// the host page's CSS cannot reach in (and ours cannot leak out).
(function () {
  'use strict';

  var script = document.currentScript;
  if (!script || !script.src) return;
  var src = new URL(script.src);
  var HTTP = src.origin;
  var WS = (src.protocol === 'https:' ? 'wss://' : 'ws://') + src.host + '/aim';
  var MODE = script.getAttribute('data-mode') === 'inline' ? 'inline' : 'button';
  var TARGET = script.getAttribute('data-target');
  var VERSION = 'comfyaim-web 0.1';
  var MAX_LINES = 300;

  // ------------------------------------------------------------------------------------------------
  // storage, which a private window or a blocked site may refuse

  function get(k) { try { return localStorage.getItem('comfyaim.' + k); } catch (e) { return null; } }
  function put(k, v) { try { localStorage.setItem('comfyaim.' + k, v); } catch (e) { /* kept for this page only */ } }

  function secret() {
    var s = get('secret');
    if (s && /^[0-9a-f]{32}$/.test(s)) return s;
    var b = new Uint8Array(16);
    crypto.getRandomValues(b);
    s = Array.prototype.map.call(b, function (x) { return (x < 16 ? '0' : '') + x.toString(16); }).join('');
    put('secret', s);
    return s;
  }

  // ------------------------------------------------------------------------------------------------
  // the frame

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  var host = el('div');
  if (MODE === 'inline') {
    var into = TARGET && document.querySelector(TARGET);
    if (!into) return;
    into.appendChild(host);
  } else {
    document.body.appendChild(host);
  }
  var root = host.attachShadow({ mode: 'open' });
  var css = el('link');
  css.rel = 'stylesheet';
  css.href = HTTP + '/aim/widget.css';
  root.appendChild(css);

  var fab, badge;
  if (MODE === 'button') {
    fab = el('button', 'fab');
    fab.type = 'button';
    fab.setAttribute('aria-label', 'AIM chat room');
    fab.appendChild(el('span', 'fab-label', 'AIM'));
    badge = el('span', 'badge');
    fab.appendChild(badge);
    root.appendChild(fab);
  }

  var panel = el('section', 'panel ' + MODE);
  panel.setAttribute('aria-label', 'AIM chat room');
  root.appendChild(panel);

  var head = el('header', 'head');
  var title = el('span', 'title', 'AIM');
  var status = el('span', 'status');
  var actions = el('span', 'actions');
  var nameBtn = el('button', 'btn', 'Change Name');
  var signBtn = el('button', 'btn', 'Sign On');
  nameBtn.type = signBtn.type = 'button';
  actions.appendChild(nameBtn);
  actions.appendChild(signBtn);
  var closeBtn;
  if (MODE === 'button') {
    closeBtn = el('button', 'close', '×');
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', 'Close');
    actions.appendChild(closeBtn);
  }
  head.appendChild(title);
  head.appendChild(status);
  head.appendChild(actions);
  panel.appendChild(head);

  var body = el('div', 'body');
  var room = el('div', 'room');
  room.setAttribute('role', 'log');
  room.setAttribute('aria-live', 'polite');
  var list = el('div', 'buddies');
  var listTitle = el('div', 'buddies-title', 'Online (0)');
  var listItems = el('ul', 'buddies-list');
  list.appendChild(listTitle);
  list.appendChild(listItems);
  body.appendChild(room);
  body.appendChild(list);
  panel.appendChild(body);

  var form = el('form', 'composer');
  var input = el('input', 'input');
  input.type = 'text';
  input.maxLength = 255;
  input.autocomplete = 'off';
  input.setAttribute('aria-label', 'Message');
  form.appendChild(input);
  panel.appendChild(form);

  // The name box, over the panel.
  var nameForm = el('form', 'namebox');
  nameForm.hidden = true;
  var nameLabel = el('label', 'namebox-label', 'Your name in the AIM room');
  var nameInput = el('input', 'input');
  nameInput.type = 'text';
  nameInput.maxLength = 16;
  nameInput.autocomplete = 'off';
  nameInput.id = 'aim-name';
  nameLabel.htmlFor = 'aim-name';
  var nameError = el('div', 'namebox-error');
  var nameRow = el('div', 'namebox-row');
  var nameOk = el('button', 'btn', 'Save');
  var nameCancel = el('button', 'btn', 'Cancel');
  nameOk.type = 'submit';
  nameCancel.type = 'button';
  nameRow.appendChild(nameOk);
  nameRow.appendChild(nameCancel);
  nameForm.appendChild(nameLabel);
  nameForm.appendChild(nameInput);
  nameForm.appendChild(nameError);
  nameForm.appendChild(nameRow);
  panel.appendChild(nameForm);

  // ------------------------------------------------------------------------------------------------
  // state

  var state = 'off';          // off, connecting, online, offline (trying again), replaced, banned
  var nick = get('nick') || '';
  var wanted = '';            // a name asked for and not yet welcomed
  var buddies = [];           // [nick, where]
  var seen = {}, seenOrder = [];
  var ws = null, wait = 2000, retry = null;

  function statusText() {
    if (state === 'online') return 'Online as ' + nick;
    if (state === 'connecting') return 'Connecting';
    if (state === 'offline') return 'Offline. Trying again.';
    if (state === 'replaced') return 'Signed on in another window.';
    if (state === 'banned') return 'Banned from the room.';
    return 'Not signed on';
  }

  function trying() { return state === 'online' || state === 'connecting' || state === 'offline'; }

  function refresh() {
    status.textContent = statusText();
    status.className = 'status' + (state === 'online' ? ' on' : '');
    signBtn.textContent = trying() ? 'Sign Off' : 'Sign On';
    input.disabled = state !== 'online';
    input.placeholder = state === 'online' ? 'Type your message' : 'Sign on to talk';
    listTitle.textContent = 'Online (' + buddies.length + ')';
    listItems.textContent = '';
    buddies.forEach(function (b) {
      var li = el('li', b[0] === nick ? 'me' : '');
      li.appendChild(el('span', 'buddy', b[0]));
      if (b[1]) li.appendChild(el('span', 'where', b[1]));
      li.title = b[1] ? b[0] + ', ' + b[1] : b[0];
      listItems.appendChild(li);
    });
    if (badge) badge.textContent = buddies.length ? String(buddies.length) : '';
  }

  // The game's escape codes, drawn the way the game would show them: colours dropped, links as their text.
  function plain(t) {
    return String(t || '')
      .replace(/\|c[0-9a-fA-F]{8}/g, '').replace(/\|r/g, '')
      .replace(/\|H[^|]*\|h(\[[^\]]*\])\|h/g, '$1')
      .replace(/\|\|/g, '|');
  }

  function clock(ts) {
    var d = new Date(Number(ts) * 1000);
    if (isNaN(d)) return '';
    return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
  }

  function nearBottom() { return room.scrollHeight - room.scrollTop - room.clientHeight < 40; }

  function addLine(node) {
    var stick = nearBottom();
    room.appendChild(node);
    while (room.childNodes.length > MAX_LINES) room.removeChild(room.firstChild);
    if (stick) room.scrollTop = room.scrollHeight;
  }

  function addNote(text, cls) { addLine(el('div', 'line note' + (cls ? ' ' + cls : ''), text)); }

  function addMsg(ts, from, text, where) {
    var key = ts + '\t' + from + '\t' + text;
    if (seen[key]) return;
    seen[key] = true;
    seenOrder.push(key);
    if (seenOrder.length > 600) delete seen[seenOrder.shift()];
    var line = el('div', 'line');
    line.appendChild(el('span', 'time', clock(ts)));
    line.appendChild(el('span', 'nick', from));
    if (where) line.appendChild(el('span', 'where', where));
    line.appendChild(el('span', 'text', plain(text)));
    addLine(line);
    if (fab && panel.hidden) fab.classList.add('new');
  }

  function setBuddy(n, on, where) {
    var low = n.toLowerCase(), was = false;
    buddies = buddies.filter(function (b) { if (b[0].toLowerCase() === low) { was = true; return false; } return true; });
    if (on) {
      buddies.push([n, where || '']);
      buddies.sort(function (a, b) { return a[0].toLowerCase() < b[0].toLowerCase() ? -1 : 1; });
    }
    return !was;
  }

  // ------------------------------------------------------------------------------------------------
  // the room, read without signing on

  function peek(lines) {
    fetch(HTTP + '/aim?lines=' + lines, { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (j) {
      if (trying()) return;          // the socket got there first and knows better
      buddies = j.who || [];
      (j.lines || []).forEach(function (l) { addMsg(l[0], l[1], l[2], l[3]); });
      refresh();
    }).catch(function () { /* the room is down; the button just shows no number */ });
  }

  // ------------------------------------------------------------------------------------------------
  // the connection

  function send(fields) { if (ws && ws.readyState === 1) ws.send(fields.join('\t')); }

  function hello(name) { send(['HELLO', name, secret(), VERSION, 'WEB', '']); }

  function connect() {
    if (ws) return;
    clearTimeout(retry);
    var name = wanted || nick;
    if (!name) { openName(); return; }
    state = 'connecting';
    refresh();
    // Each handler checks it still belongs to the socket in use: after Sign Off and a quick Sign On,
    // the old socket's close arrives late and must not clear the new one.
    var sock = new WebSocket(WS);
    ws = sock;
    sock.onopen = function () { if (ws !== sock) return; wait = 2000; hello(name); };
    sock.onmessage = function (e) { if (ws === sock) onLine(String(e.data)); };
    sock.onclose = function () {
      if (ws !== sock) return;
      ws = null;
      if (!trying()) { refresh(); return; }
      if (state === 'online') addNote('Lost the room. Trying again.');
      state = 'offline';
      refresh();
      retry = setTimeout(connect, wait);
      wait = Math.min(wait * 2, 60000);
    };
  }

  // stop: close and stay closed, as the DLL does after a ban, a second window or Sign Off.
  function stop(why) {
    state = why;
    clearTimeout(retry);
    if (ws) { var w = ws; ws = null; w.close(); }
    buddies = [];
    refresh();
  }

  function onLine(line) {
    var f = line.split('\t'), kind = f[0];
    if (kind === 'WELCOME') {
      nick = f[1] || nick;
      wanted = '';
      put('nick', nick);
      put('on', '1');
      state = 'online';
      nameForm.hidden = true;
      addNote('Signed on as ' + nick + '.');
    } else if (kind === 'HIST' || kind === 'MSG') {
      addMsg(f[1], f[2] || '?', f[3] || '', f[4]);
    } else if (kind === 'JOIN') {
      if (setBuddy(f[1], true, f[2])) addNote(f[1] + ' signed on.');
    } else if (kind === 'PART') {
      setBuddy(f[1], false);
      addNote(f[1] + ' signed off.');
    } else if (kind === 'WHO') {
      buddies = [];
      for (var i = 1; i + 1 <= f.length; i += 2) if (f[i]) buddies.push([f[i], f[i + 1] || '']);
    } else if (kind === 'SYS') {
      addNote(f[1] || '', 'sys');
    } else if (kind === 'ERR') {
      var code = f[1], text = f[2] || '';
      if (code === 'taken' || code === 'nick') {
        wanted = '';
        if (state !== 'online') stop('off');
        openName(text);
      } else if (code === 'replaced' || code === 'banned') {
        addNote(text, 'err');
        stop(code);
      } else {
        addNote(text, 'err');
      }
    }
    refresh();
  }

  // ------------------------------------------------------------------------------------------------
  // what the buttons do

  function openName(error) {
    nameForm.hidden = false;
    nameInput.value = wanted || nick;
    nameError.textContent = error || '';
    nameOk.textContent = trying() ? 'Save' : 'Sign On';
    nameInput.focus();
    nameInput.select();
  }

  nameForm.addEventListener('submit', function (e) {
    e.preventDefault();
    var n = nameInput.value.replace(/\s/g, '');
    if (!/^[A-Za-z0-9_]{2,16}$/.test(n)) { nameError.textContent = '2 to 16 letters, digits or _.'; return; }
    wanted = n;
    nameForm.hidden = true;
    if (state === 'online') hello(n);   // a second HELLO renames
    else connect();
  });
  nameCancel.addEventListener('click', function () { nameForm.hidden = true; });
  nameBtn.addEventListener('click', function () { openName(); });

  signBtn.addEventListener('click', function () {
    if (trying()) {
      put('on', '0');
      stop('off');
      addNote('Signed off.');
    } else if (nick) {
      put('on', '1');
      connect();
    } else {
      openName();
    }
  });

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var text = input.value.replace(/[\t\r\n]/g, ' ').trim();
    if (!text || state !== 'online') return;
    send(['SAY', text]);
    input.value = '';
  });

  function show(open) {
    panel.hidden = !open;
    if (fab) {
      fab.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (open) fab.classList.remove('new');
    }
    put('open', open ? '1' : '0');
    if (open) {
      room.scrollTop = room.scrollHeight;
      if (!trying() && !room.childNodes.length) peek(100);
      if (state === 'online') input.focus();
    }
  }

  // A page left for another is often kept whole in the browser's back/forward cache, WebSocket and
  // all, and the room then showed the visitor online long after they had moved on. So the socket is
  // closed when the page is hidden, and opened again if the page is brought back from the cache. The
  // hub's grace hides the gap from everybody else.
  window.addEventListener('pagehide', function () {
    if (!ws) return;
    var w = ws;
    ws = null;
    w.close();
  });
  window.addEventListener('pageshow', function (e) {
    if (e.persisted && trying() && !ws) connect();
  });

  if (fab) {
    fab.addEventListener('click', function () { show(panel.hidden); });
    closeBtn.addEventListener('click', function () { show(false); });
    root.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !panel.hidden) show(false); });
  }

  // ------------------------------------------------------------------------------------------------
  // start

  // The panel stays open from page to page, so the room can be followed while browsing the site.
  if (fab) {
    panel.hidden = get('open') !== '1';
    fab.setAttribute('aria-expanded', panel.hidden ? 'false' : 'true');
  }
  refresh();
  if (get('on') === '1' && nick) connect();
  else peek(MODE === 'inline' || !panel.hidden ? 100 : 0);
})();
