#include "config.h"

Settings g_cfg;

namespace
{
    const wchar_t* kHub     = L"hub";
    const wchar_t* kGeneral = L"general";

    int GetI(const wchar_t* sec, const wchar_t* key, int dflt, const wchar_t* ini)
    {
        return static_cast<int>(GetPrivateProfileIntW(sec, key, dflt, ini));
    }

    bool GetB(const wchar_t* sec, const wchar_t* key, bool dflt, const wchar_t* ini)
    {
        return GetPrivateProfileIntW(sec, key, dflt ? 1 : 0, ini) != 0;
    }
}

void ResolveIniPath(HMODULE self, wchar_t* out, size_t count)
{
    GetModuleFileNameW(self, out, static_cast<DWORD>(count));
    wchar_t* slash = wcsrchr(out, L'\\');
    if (slash)
        wcscpy_s(slash + 1, count - (slash + 1 - out), L"comfyaim.ini");
}

void LoadSettings(const wchar_t* ini)
{
    Settings s;

    s.enabled = GetB(kHub, L"enabled", s.enabled, ini);
    wchar_t url[256] = {};
    GetPrivateProfileStringW(kHub, L"url", s.hubUrl, url, 256, ini);
    // An ini comment after the value comes back as part of it: cut at the first space or ';'.
    for (wchar_t* p = url; *p; ++p)
        if (*p == L' ' || *p == L'\t' || *p == L';')
        {
            *p = 0;
            break;
        }
    if (url[0])
        wcscpy_s(s.hubUrl, url);

    s.logEnabled  = GetB(kGeneral, L"log",         s.logEnabled,  ini);
    s.hook        = GetB(kGeneral, L"hook",        s.hook,        ini);
    s.chainWaitMs = GetI(kGeneral, L"chainWaitMs", s.chainWaitMs, ini);

    g_cfg = s;
}
