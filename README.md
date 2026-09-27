# comfyaim

> **Bugs, questions and screenshots. Ty for testing!: [join our Discord](https://discord.gg/YSWzYk8xP).**
>
> [![Discord](https://img.shields.io/badge/Discord-ComfyCraft-5865F2?logo=discord&logoColor=white&style=for-the-badge)](https://discord.gg/YSWzYk8xP)

One chat room for everybody who plays World of Warcraft 1.12 on a server of their own. Type `/a hello` in game,
and every player with comfyaim sees it, whatever server they are on.

<img width="692" height="396" alt="image" src="https://github.com/user-attachments/assets/ee7e24ed-5c51-47a5-9b2e-edebdb63e1d1" />


<!-- owner's line goes here -->

## Features

| | What it does |
| --- | --- |
| **`/a`** | A chat type, like `/p` for party. `/a hello` talks in the room, and the chat box stays in AIM mode after Enter. |
| **The AIM window** | The room, a buddy list of who is online, a box to type in, and the Change Name, Sign On and Sign Off buttons. Drag the dots in the corner to resize it. |
| **Friends list button** | The running figure between Add Friend and Send Message opens the window. The number on it is how many are online. |
| **Servers** | Each name shows where that player is: the server's tag, such as COMFY or OCTO, or the realm name for a server that is not in [`servers.txt`](servers.txt). |
| **Your nick** | Your first character's name, unless somebody has it. It stays yours on every server you play on. |

## Commands

| Command | |
| --- | --- |
| `/a <text>` | Talk in the room. |
| `/aim` | Open or close the window. |
| `/aim nick <name>` | Change your nick: 2 to 16 letters, digits or `_`. `/aim nick` alone opens the Change Name box. |
| `/aim who` | List who is online. |
| `/aim ignore <nick>`, `/aim unignore <nick>` | Hide or show a player's lines. |
| `/aim chat <1-7>`, `/aim chat off` | Which chat window shows the room. Off shows it only in the AIM window. |
| `/aim on`, `/aim off` | Sign on or off, the same as the button. Signed off stays signed off after a restart. |

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
| `[hub] nick`, `secret`, `realm`, `address` | Written by comfyaim. The secret proves the nick is yours. Do not share it. |

A copy of `comfyaim.ini` in a second client folder signs on as the same person, and throws the first one off.

## On a website

Put the room on any web page with one line. It draws an AIM button in the corner of the page:

```html
<script src="https://comfycraft.dedyn.io/aim/widget.js" defer></script>
```

To draw the room into the page instead:

```html
<div id="aim"></div>
<script src="https://comfycraft.dedyn.io/aim/widget.js" data-mode="inline" data-target="#aim" defer></script>
```

Visitors pick a name and show as WEB. A page with a Content-Security-Policy must allow `comfycraft.dedyn.io` for scripts, styles and connections.

## Add your server

Add one line to [`servers.txt`](servers.txt) with a pull request: a short tag, the login address players type as their realmlist, and the name. Once it is merged, players on your server show your tag within 10 minutes. Only public servers, and no IP addresses.

Your login address goes to the room so it can find your tag. The room shows nobody the address.

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
