// net: the connection to the hub, a WinHTTP WebSocket run on threads of its own.
//
// The render thread never waits on the network. It hands lines over through two queues:
// NetSend puts a line on the way out, NetPoll takes one line that came in.
//
// Besides the hub's own lines, net makes one of its own for Lua:
//   LOCAL  state  <nonick | connecting | connected | online | offline | banned | replaced | badurl>  <nick>
#pragma once

#include <string>
#include <vector>

void NetStart(const wchar_t* iniPath);   // reads nick and secret, starts the threads; call once
void NetSend(const std::string& line);  // a line for the hub
void NetCommand(const std::string& cmd); // a line for the DLL itself: "nick\t<name>", "state", "reconnect"
bool NetPoll(std::string& line);        // false when nothing is waiting

// What a new Lua state needs to catch up: the state line, then the recent room lines as HIST. Clears
// the in queue, since everything in it is in the snapshot or older than it.
std::vector<std::string> NetSnapshot();
