// bridge: the way between this DLL and the client's Lua. Runs on the render thread.
#pragma once

void BridgeTick();   // call from Present, every frame
