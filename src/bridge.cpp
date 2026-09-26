// bridge: the way between this DLL and the client's Lua.
//
// Lua to the DLL is a CVar. The DLL registers comfyAimOut, the addon writes "<seq>\t<line>" into it with
// SetCVar, and this file reads it back a few times a second (the value string is at +0x20). A new seq is
// a new line to send. This is the same path comfyatmosphere's sliders use, and its notes in cvars.cpp
// cover how the two CVar functions were found.
//
// The DLL to Lua is FrameScript_Execute, which runs a string of Lua. Found in this WoW.exe at 0x00704CD0:
//
//   56           push esi
//   6A 00        push 0
//   8B F1        mov  esi, ecx          ; the Lua text
//   52           push edx               ; the name the chunk is known by in an error
//   56           push esi
//   E8 ....      call 0x0064A6F0
//   8B D0        mov  edx, eax
//   8B CE        mov  ecx, esi
//   E8 ....      call 0x00704AE0
//   5E           pop  esi
//   C3           ret                    ; no stack arguments
//
// So: void __fastcall FrameScript_Execute(const char* lua, const char* chunkName). Every string this
// file runs is wrapped in pcall, and every piece of text in it is escaped as a Lua string literal, so
// nothing the hub sends can become code or raise an error dialog.
//
// The glue screens (login, character select) and the world each have a Lua state of their own, and the
// client swaps them. So the Lua state pointer is watched: a new one waits kLuaSettle seconds, as
// cvars.cpp does, before anything runs in it.
//
// Then the DLL says "hello" every kHelloEvery seconds until it is answered: Lua that writes a number into
// comfyAimIn, but only when ComfyAim_OnLine exists. So an answer means Lua ran, this is the world, and
// the addon has loaded; the world's Lua state is up well before the addons are. The glue has neither,
// so it never answers.
//
// A /reload does NOT make a new Lua state: the pointer stays the same. So the addon writes "0" into
// comfyAimIn as it loads, and the DLL, reading a value that is not its last hello, says hello again and
// gives the new UI the state and the recent room.

#define WIN32_LEAN_AND_MEAN

#include <windows.h>

#include "bridge.h"
#include "common.h"
#include "config.h"
#include "net.h"

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

namespace
{
    constexpr DWORD  kLookup         = 0x0063DEC0;
    constexpr DWORD  kRegister       = 0x0063DB90;
    constexpr DWORD  kHashMask       = 0x00C4EDB8;   // -1 until the client's CVar table exists
    constexpr DWORD  kCategory       = 9;            // what the Lua RegisterCVar passes
    constexpr DWORD  kLuaStateGetter = 0x007040D0;
    constexpr DWORD  kLuaState       = 0x00CEEF74;
    constexpr DWORD  kExecute        = 0x00704CD0;
    constexpr double kLuaSettle      = 1.0;
    constexpr int    kLinesPerFrame  = 10;
    constexpr double kHelloEvery     = 0.5;

    // -1 marks bytes that are an address or a call offset, skipped so a relocated image still matches.
    const int kLookupHead[]   = { 0x83, 0x3D, -1, -1, -1, -1, 0xFF, 0x53, 0x56, 0x57, 0x8B, 0xF9 };
    const int kRegisterHead[] = { 0x55, 0x8B, 0xEC, 0x51, 0x83, 0x3D, -1, -1, -1, -1, 0xFF, 0x53 };
    const int kGetterHead[]   = { 0xA1, -1, -1, -1, -1, 0xC3 };
    const int kExecuteHead[]  = { 0x56, 0x6A, 0x00, 0x8B, 0xF1, 0x52, 0x56, 0xE8, -1, -1, -1, -1,
                                  0x8B, 0xD0, 0x8B, 0xCE, 0xE8 };

    using LookupFn   = void* (__fastcall*)(const char* name);
    using RegisterFn = void* (__fastcall*)(const char* name, const char* help, DWORD flags,
                                           const char* dflt, void* callback, DWORD category,
                                           DWORD arg5, void* cbArg);
    using ExecuteFn  = void (__fastcall*)(const char* lua, const char* chunkName);

    bool   g_checked = false, g_gaveUp = false, g_registered = false;
    void*  g_cvOut   = nullptr;     // comfyAimOut: Lua to the DLL
    void*  g_cvIn    = nullptr;     // comfyAimIn: the world state answering the hello

    DWORD  g_state      = 0;        // the Lua state last seen
    double g_stateSince = 0.0;      // when it was first seen
    double g_helloAt    = 0.0;      // when the last hello ran, 0 for "say it now"
    bool   g_world      = false;    // a hello was answered: the addon is there to take lines
    // Config.wtf keeps comfyAimIn from the last session, so counting from 0 again would let an old
    // answer match a new hello. Starting from the clock makes that a one-in-a-million chance.
    int    g_helloId    = static_cast<int>(GetTickCount() % 1000000) + 1000;

    std::string g_lastOut;          // the comfyAimOut value last acted on
    double      g_nextRead = 0.0;

    intptr_t Slide()
    {
        static const intptr_t slide = reinterpret_cast<intptr_t>(GetModuleHandleW(nullptr)) - 0x00400000;
        return slide;
    }

    bool SafeCopy(uintptr_t src, void* dst, size_t n)
    {
        __try
        {
            memcpy(dst, reinterpret_cast<const void*>(src), n);
            return true;
        }
        __except (EXCEPTION_EXECUTE_HANDLER)
        {
            return false;
        }
    }

    bool SafeString(uintptr_t src, char* out, size_t cap)
    {
        __try
        {
            const char* s = reinterpret_cast<const char*>(src);
            size_t i = 0;
            for (; i + 1 < cap && s[i]; ++i)
                out[i] = s[i];
            out[i] = 0;
            return true;
        }
        __except (EXCEPTION_EXECUTE_HANDLER)
        {
            out[0] = 0;
            return false;
        }
    }

    bool HeadMatches(DWORD addr, const int* head, size_t n)
    {
        unsigned char b[32] = {};
        if (n > sizeof(b) || !SafeCopy(addr + Slide(), b, n))
            return false;
        for (size_t i = 0; i < n; ++i)
            if (head[i] >= 0 && b[i] != head[i])
                return false;
        return true;
    }

#define HEAD(addr, h) HeadMatches(addr, h, sizeof(h) / sizeof(h[0]))

    bool ReadCVar(void* cv, char* out, size_t cap)
    {
        DWORD str = 0;
        return cv && SafeCopy(reinterpret_cast<uintptr_t>(cv) + 0x20, &str, 4) && str && SafeString(str, out, cap);
    }

    void* RegisterCVar(const char* name)
    {
        const auto lookup     = reinterpret_cast<LookupFn>(kLookup + Slide());
        const auto registerFn = reinterpret_cast<RegisterFn>(kRegister + Slide());
        void* cv = lookup(name);
        if (!cv)
            cv = registerFn(name, nullptr, 0, "", nullptr, kCategory, 0, nullptr);
        if (!cv)
            Log("bridge: could not register CVar %s", name);
        return cv;
    }

    // Text as a Lua string literal. Lua 5.0 reads \ddd as a decimal byte, which covers every control
    // character; bytes from 0x80 up pass through, since the client draws UTF-8.
    std::string Quote(const std::string& s)
    {
        std::string q = "\"";
        for (unsigned char c : s)
        {
            if (c == '\\' || c == '"')
            {
                q += '\\';
                q += static_cast<char>(c);
            }
            else if (c < 32 || c == 127)
            {
                char esc[8];
                snprintf(esc, sizeof(esc), "\\%03u", c);
                q += esc;
            }
            else
            {
                q += static_cast<char>(c);
            }
        }
        q += '"';
        return q;
    }

    void Run(const std::string& lua)
    {
        const auto exec = reinterpret_cast<ExecuteFn>(kExecute + Slide());
        const std::string wrapped = "pcall(function() " + lua + " end)";
        exec(wrapped.c_str(), "comfyaim");
    }

    void SayHello()
    {
        ++g_helloId;
        char lua[256];
        snprintf(lua, sizeof(lua),
                 "if SetCVar and ComfyAim_OnLine then SetCVar(\"comfyAimIn\", \"%d\") end", g_helloId);
        Run(lua);
        g_helloAt = Now();
    }

    // A line for the addon. Without the addon there is nobody to show it to, and it is dropped.
    void Deliver(const std::string& line)
    {
        Run("if ComfyAim_OnLine then ComfyAim_OnLine(" + Quote(line) + ") end");
    }

    bool Check()
    {
        if (!HEAD(kLookup, kLookupHead) || !HEAD(kRegister, kRegisterHead) ||
            !HEAD(kLuaStateGetter, kGetterHead) || !HEAD(kExecute, kExecuteHead))
        {
            Log("bridge: the client functions are not where this WoW.exe keeps them: comfyaim stays off");
            return false;
        }
        return true;
    }
}

void BridgeTick()
{
    if (g_gaveUp)
        return;
    if (!g_checked)
    {
        if (!Check())
        {
            g_gaveUp = true;
            return;
        }
        g_checked = true;
    }

    const double now = Now();
    DWORD state = 0;
    SafeCopy(kLuaState + Slide(), &state, 4);
    if (state != g_state)
    {
        if (g_world)
            Log("bridge: Lua state %08lX gone, now %08lX", g_state, state);
        g_state = state;
        g_stateSince = now;
        g_helloAt = 0.0;
        g_world = false;
    }
    if (!state || now - g_stateSince < kLuaSettle)
        return;

    if (!g_registered)
    {
        DWORD mask = 0xFFFFFFFF;
        if (!SafeCopy(kHashMask + Slide(), &mask, 4) || mask == 0xFFFFFFFF)
            return;
        g_cvOut = RegisterCVar("comfyAimOut");
        g_cvIn  = RegisterCVar("comfyAimIn");
        g_registered = true;
        // Config.wtf keeps the last value from the session before; that line was sent then.
        char old[512];
        if (ReadCVar(g_cvOut, old, sizeof(old)))
            g_lastOut = old;
        Log("bridge: CVars registered, %.1f s after this Lua state came up", now - g_stateSince);
    }

    if (!g_world && (g_helloAt == 0.0 || now - g_helloAt >= kHelloEvery))
        SayHello();

    if (now < g_nextRead)
        return;
    g_nextRead = now + 0.1;

    char buf[1024];
    const bool answered = ReadCVar(g_cvIn, buf, sizeof(buf)) && atoi(buf) == g_helloId;
    if (g_world && !answered)
    {
        Log("bridge: comfyAimIn is \"%s\", not hello %d: a new UI (a /reload), saying hello again", buf,
            g_helloId);
        g_world = false;
        g_helloAt = 0.0;
    }
    else if (!g_world && answered)
    {
        g_world = true;
        // A new UI (a login or a /reload) starts empty: give it the state and the recent room.
        const std::vector<std::string> snap = NetSnapshot();
        for (const std::string& line : snap)
            Deliver(line);
        Log("bridge: Lua answered hello %d: this state is the world, %u lines replayed", g_helloId,
            static_cast<unsigned>(snap.size()));
    }

    // "<seq>\t<line>". The addon writes one line, waits for ComfyAim_Ack(seq), clears the CVar and writes
    // the next. So a changed value is a new line, and an empty one is the addon clearing up.
    if (ReadCVar(g_cvOut, buf, sizeof(buf)) && g_lastOut != buf)
    {
        g_lastOut = buf;
        const char* tab = strchr(buf, '\t');
        if (buf[0] && tab)
        {
            const std::string line = tab + 1;
            if (line.compare(0, 4, "DLL\t") == 0)
                NetCommand(line.substr(4));
            else
                NetSend(line);
            Run("if ComfyAim_Ack then ComfyAim_Ack(" + std::to_string(atoi(buf)) + ") end");
        }
    }

    if (!g_world)
        return;
    std::string line;
    for (int i = 0; i < kLinesPerFrame && NetPoll(line); ++i)
        Deliver(line);
}
