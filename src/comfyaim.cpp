// comfyaim: one chat room shared by players on any server, typed into with /aim.
//
// The DLL holds the connection to the hub, since 1.12 Lua cannot open a socket. The addon talks to the
// DLL through a CVar, and the DLL talks back by running Lua (bridge.cpp). All Lua work is done on the
// client's main thread, from Present, the way comfyatmosphere reads its sliders; the network runs on
// threads of its own (net.cpp) and meets the main thread only at two queues.
//
// Attaching is comfytime's: a throwaway device names DXVK's shared IDirect3DDevice9 vtable, and the
// Present slot in it is patched in place with a compare-exchange. comfygrass, comfyfog and comfytime
// patch the same vtable at start-up, so comfyaim waits for the last of them to finish first.

#define CINTERFACE
#define WIN32_LEAN_AND_MEAN

#include <windows.h>
#include <d3d9.h>

#include "bridge.h"
#include "common.h"
#include "config.h"
#include "net.h"

#include <cstdarg>
#include <cstdio>

namespace
{
    wchar_t g_iniPath[MAX_PATH] = {};
    wchar_t g_logPath[MAX_PATH] = {};

    // Four threads log; one lock keeps lines whole.
    CRITICAL_SECTION g_lock;
    bool             g_lockReady = false;

    struct Guard
    {
        Guard()  { if (g_lockReady) EnterCriticalSection(&g_lock); }
        ~Guard() { if (g_lockReady) LeaveCriticalSection(&g_lock); }
    };
}

void Log(const char* fmt, ...)
{
    if (!g_cfg.logEnabled)
        return;
    Guard g;
    FILE* f = nullptr;
    if (_wfopen_s(&f, g_logPath, L"a") != 0 || !f)
        return;
    SYSTEMTIME t;
    GetLocalTime(&t);
    fprintf(f, "%02d:%02d:%02d.%03d ", t.wHour, t.wMinute, t.wSecond, t.wMilliseconds);
    va_list ap;
    va_start(ap, fmt);
    vfprintf(f, fmt, ap);
    va_end(ap);
    fputc('\n', f);
    fclose(f);
}

double Now()
{
    static double inv = [] {
        LARGE_INTEGER f;
        QueryPerformanceFrequency(&f);
        return 1.0 / static_cast<double>(f.QuadPart);
    }();
    LARGE_INTEGER t;
    QueryPerformanceCounter(&t);
    return static_cast<double>(t.QuadPart) * inv;
}

namespace
{
    // In place, never a copy, and as a compare-exchange: other mods patch this same slot.
    bool HookSlot(void** slot, void* hook, void** origOut)
    {
        if (*slot == hook)
            return true;
        DWORD prot = 0;
        if (!VirtualProtect(slot, sizeof(void*), PAGE_READWRITE, &prot))
            return false;
        void* cur = *slot;
        while (cur != hook)
        {
            *origOut = cur;   // set before the swap, so the hook never runs with a null original
            void* prev = InterlockedCompareExchangePointer(slot, hook, cur);
            if (prev == cur)
                break;
            cur = prev;
        }
        VirtualProtect(slot, sizeof(void*), prot, &prot);
        return true;
    }

    using PresentFn = HRESULT(STDMETHODCALLTYPE*)(IDirect3DDevice9*, const RECT*, const RECT*, HWND, const RGNDATA*);
    PresentFn g_oPresent = nullptr;

    HRESULT STDMETHODCALLTYPE hkPresent(IDirect3DDevice9* dev, const RECT* src, const RECT* dst, HWND wnd,
                                        const RGNDATA* dirty)
    {
        BridgeTick();
        return g_oPresent(dev, src, dst, wnd, dirty);
    }

    // ---------------------------------------------------------------------------------------------
    // attaching

    HMODULE OwnerOf(const void* fn)
    {
        HMODULE m = nullptr;
        GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
                           reinterpret_cast<LPCWSTR>(fn), &m);
        return m;
    }

    // Until the last sibling to attach has patched the last slot it installs. They attach in the order
    // comfygrass, comfyfog, comfytime, each waiting for the ones before it, so only the last loaded one
    // needs watching: comfytime's last slot is BeginScene, comfyfog's DrawIndexedPrimitiveUP,
    // comfygrass's DrawIndexedPrimitive.
    void WaitForSiblings(IDirect3DDevice9Vtbl* v)
    {
        const char* name = nullptr;
        HMODULE     mod  = nullptr;
        const void* const* slot = nullptr;
        if ((mod = GetModuleHandleA("comfytime.dll")) != nullptr)
            name = "comfytime", slot = reinterpret_cast<const void* const*>(&v->BeginScene);
        else if ((mod = GetModuleHandleA("comfyfog.dll")) != nullptr)
            name = "comfyfog", slot = reinterpret_cast<const void* const*>(&v->DrawIndexedPrimitiveUP);
        else if ((mod = GetModuleHandleA("comfygrass.dll")) != nullptr)
            name = "comfygrass", slot = reinterpret_cast<const void* const*>(&v->DrawIndexedPrimitive);
        if (!mod)
        {
            Log("no comfygrass, comfyfog or comfytime loaded, patching straight away");
            return;
        }
        const double t0 = Now();
        while (OwnerOf(*slot) != mod)
        {
            if ((Now() - t0) * 1000.0 > g_cfg.chainWaitMs)
            {
                Log("%s loaded but not finished within %d ms; patching anyway", name, g_cfg.chainWaitMs);
                return;
            }
            Sleep(20);
        }
        Log("%s patched first (waited %.0f ms), chaining on top", name, 1000.0 * (Now() - t0));
    }

    using Direct3DCreate9Fn = IDirect3D9*(WINAPI*)(UINT);

    bool AttachToDxvk()
    {
        HMODULE d3d9 = GetModuleHandleA("d3d9.dll");
        if (!d3d9)
            d3d9 = LoadLibraryA("d3d9.dll");
        if (!d3d9)
        {
            Log("FATAL: no d3d9.dll in this process");
            return false;
        }
        HMODULE pin = nullptr;   // our hook lives in its vtable: it must never unload under us
        GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_PIN, L"d3d9.dll", &pin);

        auto create = reinterpret_cast<Direct3DCreate9Fn>(GetProcAddress(d3d9, "Direct3DCreate9"));
        IDirect3D9* d3d = create ? create(D3D_SDK_VERSION) : nullptr;
        if (!d3d)
        {
            Log("FATAL: Direct3DCreate9 unavailable");
            return false;
        }

        WNDCLASSEXA wc = {};
        wc.cbSize        = sizeof(wc);
        wc.lpfnWndProc   = DefWindowProcA;
        wc.hInstance     = GetModuleHandleA(nullptr);
        wc.lpszClassName = "comfyaim_probe";
        RegisterClassExA(&wc);
        HWND wnd = CreateWindowExA(0, wc.lpszClassName, "", WS_OVERLAPPED, 0, 0, 1, 1,
                                   nullptr, nullptr, wc.hInstance, nullptr);

        D3DPRESENT_PARAMETERS pp = {};
        pp.Windowed         = TRUE;
        pp.SwapEffect       = D3DSWAPEFFECT_DISCARD;
        pp.BackBufferFormat = D3DFMT_UNKNOWN;
        pp.BackBufferWidth  = 1;
        pp.BackBufferHeight = 1;
        pp.hDeviceWindow    = wnd;

        IDirect3DDevice9* probe = nullptr;
        const HRESULT hr = d3d->lpVtbl->CreateDevice(d3d, D3DADAPTER_DEFAULT, D3DDEVTYPE_HAL, wnd,
                                                     D3DCREATE_SOFTWARE_VERTEXPROCESSING | D3DCREATE_NOWINDOWCHANGES,
                                                     &pp, &probe);
        if (FAILED(hr) || !probe)
        {
            Log("FATAL: probe CreateDevice failed hr=0x%08X", hr);
            d3d->lpVtbl->Release(d3d);
            if (wnd) DestroyWindow(wnd);
            return false;
        }
        auto* v = const_cast<IDirect3DDevice9Vtbl*>(probe->lpVtbl);   // static data in the pinned d3d9.dll
        probe->lpVtbl->Release(probe);
        d3d->lpVtbl->Release(d3d);
        if (wnd) DestroyWindow(wnd);
        UnregisterClassA(wc.lpszClassName, wc.hInstance);

        WaitForSiblings(v);
        const bool ok = HookSlot(reinterpret_cast<void**>(&v->Present), &hkPresent,
                                 reinterpret_cast<void**>(&g_oPresent));
        Log("device %s (vtable %p)", ok ? "hooked" : "HOOK FAILED", v);
        return ok;
    }

    // Off the loader lock: DllMain must not load libraries or create devices.
    DWORD WINAPI AttachThread(LPVOID)
    {
        const double t0 = Now();
        const bool ok = AttachToDxvk();
        Log("attach %s in %.0f ms", ok ? "succeeded" : "FAILED", 1000.0 * (Now() - t0));
        if (ok)
            NetStart(g_iniPath);
        return 0;
    }
}

BOOL APIENTRY DllMain(HMODULE self, DWORD reason, LPVOID)
{
    if (reason == DLL_PROCESS_ATTACH)
    {
        InitializeCriticalSection(&g_lock);
        g_lockReady = true;
        DisableThreadLibraryCalls(self);

        // Our hook is a function pointer in DXVK's vtable; unloading this image would leave it dangling.
        HMODULE pin = nullptr;
        GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_PIN | GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS,
                           reinterpret_cast<LPCWSTR>(&g_lock), &pin);
        ResolveIniPath(self, g_iniPath, MAX_PATH);
        wcscpy_s(g_logPath, g_iniPath);
        wcscpy_s(wcsrchr(g_logPath, L'\\') + 1, 16, L"comfyaim.log");
        DeleteFileW(g_logPath);
        LoadSettings(g_iniPath);
        Log("comfyaim loaded (module=%p, %s)", self, g_cfg.enabled ? "enabled" : "disabled");

        if (!g_cfg.enabled)
        {
            Log("[hub] enabled = 0: no connection and nothing patched");
        }
        else if (g_cfg.hook)
        {
            HANDLE t = CreateThread(nullptr, 0, AttachThread, nullptr, 0, nullptr);
            if (t)
                CloseHandle(t);
            else
                Log("FATAL: could not start the attach thread");
        }
        else
        {
            Log("hook = 0, so nothing is patched: comfyaim is inert this run");
        }
    }
    return TRUE;
}
