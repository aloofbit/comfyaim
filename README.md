# comfyaim

> **Bugs, questions and screenshots. Ty for testing!: [join our Discord](https://discord.gg/YSWzYk8xP).**
>
> [![Discord](https://img.shields.io/badge/Discord-ComfyCraft-5865F2?logo=discord&logoColor=white&style=for-the-badge)](https://discord.gg/YSWzYk8xP)

One chat room for everybody who plays World of Warcraft 1.12 on a server of their own. Type `/a hello` in game,
and every player with comfyaim sees it, whatever server they are on.

<!-- owner's line goes here -->

## Features

| | What it does |
| --- | --- |
| **`/a` and `/aim`** | A chat type, like `/p` for party. `/a hello` talks in the room, and the chat box stays in AIM mode after Enter. |
| **The AIM window** | The room, a buddy list of who is online, and a box to type in. Drag the dots in the corner to resize it. |
| **Friends list button** | The running figure between Add Friend and Send Message opens the window. The number on it is how many are online. |
| **Realms** | Each name shows the realm that player is on. Hover a name in the buddy list to see it. |
| **Your nick** | Your first character's name, unless somebody has it. It stays yours on every server you play on. |

## Commands

| Command | |
| --- | --- |
| `/a <text>` | Talk in the room. |
| `/aim` | Open or close the window. |
| `/aim nick <name>` | Change your nick: 2 to 16 letters, digits or `_`. |
| `/aim who` | List who is online. |
| `/aim ignore <nick>`, `/aim unignore <nick>` | Hide or show a player's lines. |
| `/aim chat <1-7>`, `/aim chat off` | Which chat window shows the room. Off shows it only in the AIM window. |
| `/aim reconnect` | Connect again after you signed on from another client. |

`/a` is also the short form of `/assist` in this client. `/assist` still works. A macro that uses `/a` to
assist now talks in the room instead.

## Install

Download the zip from [Releases](https://github.com/aloofbit/comfyaim/releases), or build it (below).

1. Copy `comfyaim.dll` and `comfyaim.ini` to the client folder, next to `WoW.exe`.
2. Add the line `comfyaim.dll` to `dlls.txt`.
3. Copy the folder `addon/ComfyAim` to `Interface\AddOns`.
4. Start the game with `VanillaFixes.exe`.

It needs [VanillaFixes](https://github.com/hannesmann/vanillafixes), which loads the DLL.

## Settings

`comfyaim.ini`, in the client folder:

| Setting | |
| --- | --- |
| `[hub] enabled` | `0` turns comfyaim off. |
| `[hub] url` | The chat room to join. |
| `[hub] nick`, `secret`, `realm` | Written by comfyaim. The secret proves the nick is yours. Do not share it. |

A copy of `comfyaim.ini` in a second client folder signs on as the same person, and throws the first one off.

## Rules

The room is public and has no accounts. Lines are cut to 255 characters. Five lines in ten seconds mutes you
for thirty. The room keeps a log of what is said and the address it came from, for moderation, and admins can
kick and ban.

## Your own room

The room is `hub/server.js`, a Node program with no dependencies. Run it behind nginx for TLS and point
`[hub] url` at it. The top of the file lists its settings.

## Build

Visual Studio 2022 and CMake. **32-bit only**: the 1.12 client is x86.

```
cmake -B build -A Win32
cmake --build build --config Release
```

`comfyaim.dll` is written to the project root, next to `comfyaim.ini`.

## Licence

GPL-3.0. See [LICENSE](LICENSE).
