# comfyaim internals

Three parts: the DLL in `src/`, the addon in `addon/ComfyAim`, and the room in `hub/server.js`.

```
WoW.exe                                        hub
 ComfyAim addon ── SetCVar("comfyAimOut") ──┐
   ▲                                        ▼
   └── FrameScript_Execute ◄── comfyaim.dll ══ WebSocket ══ nginx (TLS) ── node hub/server.js
       ComfyAim_OnLine(line)   (Present hook,
                                WinHTTP threads)
```

1.12 Lua cannot open a socket, so the DLL holds the connection and the addon talks to the DLL.

## The DLL

| File | |
| --- | --- |
| `comfyaim.cpp` | Attach and the `Present` hook, copied from comfytime. Waits for comfytime, comfyfog or comfygrass to finish patching first. |
| `bridge.cpp` | Lua in both directions, on the client's main thread, from `Present`. |
| `net.cpp` | The WebSocket: a connection thread and a send thread, two queues, nick and secret. |
| `config.cpp` | `comfyaim.ini`. |

### Client addresses (build 5875)

Each is checked by its first bytes before the first call; a mismatch turns the Lua side off and logs it.

| Address | What | How it was found |
| --- | --- | --- |
| `0x00704CD0` | `void __fastcall FrameScript_Execute(const char* lua, const char* chunkName)` | Disassembled. `mov esi, ecx` / `push edx` / two calls / plain `ret`: two register arguments, no stack arguments. Proven by a spike that ran `SetCVar` through it and read the value back. |
| `0x0063DEC0` | CVar `Lookup` | From comfyatmosphere's `cvars.cpp`. |
| `0x0063DB90` | CVar `Register` | Same. |
| `0x00CEEF74` | The Lua state | Same. |

### Lua to the DLL

The DLL registers `comfyAimOut`. The addon writes `<seq>\t<line>` into it with `SetCVar`. The DLL reads the
value at `cvar+0x20` every 0.1 s and treats a changed value as a new line. It answers `ComfyAim_Ack(seq)`, and
only then does the addon clear the CVar and write its next line. Without the ack, two lines written between
two reads would lose the first.

A line starting `DLL\t` is for the DLL: `nick`, `realm`, `reconnect`, `state`. Anything else goes to the hub.

### The DLL to Lua

Every line runs as `pcall(function() if ComfyAim_OnLine then ComfyAim_OnLine("<line>") end end)`. The text is
escaped as a Lua string literal (`\\`, `\"`, `\ddd` for control bytes), so nothing from the hub can become code.

### Knowing when the UI is there

This took three attempts:

1. The glue screens and the world have separate Lua states, so the state pointer is watched, and a new one gets
   1 s before anything runs in it (comfyatmosphere's white-window lesson).
2. The world's Lua state is up well before the addons are. A line sent then reached no `ComfyAim_OnLine`. So
   the DLL says "hello" every 0.5 s: Lua that writes a number into `comfyAimIn` only when `ComfyAim_OnLine`
   exists. An answer means Lua ran, this is the world, and the addon has loaded.
3. **`/reload` keeps the same Lua state pointer.** The DLL could not see it. So the addon writes `0` into
   `comfyAimIn` as it loads, and the DLL, reading a value that is not its last hello, says hello again and
   sends the state and the last 50 room lines.

Hello numbers start from `GetTickCount()`, not 0: `Config.wtf` keeps `comfyAimIn` from the last session, and
counting from 0 once let a stale value answer a new hello.

**`GetCVar` returns nil for an empty value.** The addon's "is the DLL loaded" test reads `comfyAimIn`, never
the usually empty `comfyAimOut`.

### The network

WinHTTP gives the WebSocket (`WinHttpWebSocketCompleteUpgrade`) and TLS, so there is no third-party network
code. WinHTTP allows one receive and one send at a time on a socket, so the connection thread blocks in
receive and a separate send thread sends. The render thread never waits on either.

Reconnects wait 2 s, doubling to 60 s. `ERR banned` and `ERR replaced` stop reconnecting for the session:
reconnecting after "replaced" would throw the other client off in turn, forever.

The nick is written to the ini only after the hub's `WELCOME`, so a refused nick never reaches it.

## The addon

`/aim` and `/a` are a chat type (`ChatTypeInfo["COMFYAIM"]`, sticky), not only slash commands.
`ChatEdit_ParseText` checks `ChatTypeInfo` before `SlashCmdList`, so `/a ` switches the chat box like `/p `
does. `SendChatMessage` is wrapped to catch the type. `ChatEdit_ParseText` is wrapped too, because a bare
`/aim` + Enter leaves an empty box that never reaches `SendChatMessage`, and that is the one that opens the
window. `SlashCmdList["COMFYAIM"]` stays as a fallback for chat addons that replace `ChatEdit_ParseText`.

Text from the hub is shown with every `|` doubled.

## The hub

`hub/server.js` lists the wire format at the top. `hub/test.js` checks a running hub from outside:

```
PORT=8096 DATA=/tmp/aimtest node hub/server.js
node hub/test.js ws://127.0.0.1:8096/aim
```

| Setting | Default | |
| --- | --- | --- |
| `PORT`, `HOST` | `8095`, `127.0.0.1` | Behind nginx. `X-Real-IP` is trusted only from a loopback peer. |
| `DATA` | `hub/data` | `nicks.json`, `bans.json` (edit by hand, reloaded on change), `room.log`. |
| `ADMINS` | none | Comma-separated nicks that may kick, ban and unban. |

A nick belongs to the first secret that used it. The hub keeps `sha256(secret)` only. One secret holds one nick,
and a nick unused for 90 days is free again.
