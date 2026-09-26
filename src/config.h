// comfyaim.ini: where the hub is, and who you are on it.
#pragma once

#include <windows.h>

struct Settings
{
    bool    enabled     = true;       // installing comfyaim is the opt-in; this is the off switch
    wchar_t hubUrl[256] = L"wss://comfycraft.dedyn.io/aim";

    bool    logEnabled  = true;
    bool    hook        = true;       // 0: load, log, patch nothing (bisecting)
    int     chainWaitMs = 10000;      // how long to wait for comfygrass / comfyfog / comfytime to finish patching
};

extern Settings g_cfg;

void LoadSettings(const wchar_t* iniPath);
void ResolveIniPath(HMODULE self, wchar_t* out, size_t count);
