// net: see net.h.
//
// Two threads. The connection thread connects, says HELLO, then blocks in WinHttpWebSocketReceive until
// the socket fails, and connects again after a wait that doubles from 2 s to 60 s. The send thread
// sleeps on an event and sends whatever NetSend queued. WinHTTP allows one receive and one send on a
// socket at the same time, so the two never take turns on the network; they share the socket handle
// under g_wsLock only.
//
// Who you are is two ini values. `secret` is 16 random bytes made on the first run and never shown; the
// hub keeps only its hash and ties a nick to it. `nick` is written only when the hub has accepted it
// (WELCOME), so a refused nick never reaches the ini.
//
// Two answers stop the reconnecting for the rest of the session: ERR banned, and ERR replaced (the same
// secret signed on from another client). Reconnecting after either would only repeat it; after
// "replaced" it would throw the other client off in turn, forever. Signing off is the third stop, and
// the only one kept in the ini (`online = 0`). The Sign On button starts all three again.

#define WIN32_LEAN_AND_MEAN

#include <windows.h>
#include <winhttp.h>
#include <bcrypt.h>

#include "net.h"
#include "common.h"
#include "config.h"

#include <deque>
#include <string>

namespace
{
    CRITICAL_SECTION g_lock;       // the queues, the ring and everything about who we are
    CRITICAL_SECTION g_wsLock;     // g_ws
    HANDLE           g_sendEvent = nullptr;
    HANDLE           g_wake      = nullptr;   // a new nick or "reconnect": stop waiting and connect
    HINTERNET        g_ws        = nullptr;

    std::deque<std::string> g_in, g_out, g_ring;
    constexpr size_t kMaxQueued = 200;   // a line past this is dropped, oldest first
    constexpr size_t kRing      = 100;   // room lines kept for a /reload, the same as the hub sends

    std::wstring g_ini;
    std::string  g_secret;
    std::string  g_savedNick;    // the one in the ini: the hub accepted it once
    std::string  g_nick;         // the one to say HELLO with
    std::string  g_realm;        // the realm the player is on, from the addon; kept in the ini
    std::string  g_onlineNick;   // the one the hub welcomed on this socket, empty until then
    std::string  g_state = "offline";
    std::string  g_stop;         // "banned" or "replaced": no reconnecting until "reconnect"
    bool         g_dropSocket = false;

    const char* kVersion = "comfyaim 0.1";

    void PushInLocked(const std::string& line)
    {
        if (g_in.size() >= kMaxQueued)
            g_in.pop_front();
        g_in.push_back(line);
    }

    void PushIn(const std::string& line)
    {
        EnterCriticalSection(&g_lock);
        PushInLocked(line);
        LeaveCriticalSection(&g_lock);
    }

    std::string StateLineLocked()
    {
        return "LOCAL\tstate\t" + g_state + "\t" + (g_onlineNick.empty() ? g_nick : g_onlineNick);
    }

    void SetStateLocked(const char* state)
    {
        if (g_state == state)
            return;
        g_state = state;
        PushInLocked(StateLineLocked());
        Log("net: state %s", state);
    }

    void SetState(const char* state)
    {
        EnterCriticalSection(&g_lock);
        SetStateLocked(state);
        LeaveCriticalSection(&g_lock);
    }

    std::string ReadIni(const wchar_t* key)
    {
        wchar_t buf[128] = {};
        GetPrivateProfileStringW(L"hub", key, L"", buf, 128, g_ini.c_str());
        char out[128] = {};
        WideCharToMultiByte(CP_UTF8, 0, buf, -1, out, sizeof(out), nullptr, nullptr);
        // A realm name can hold spaces, so only a ';' comment is cut off, then the blanks before it.
        std::string s(out);
        const size_t cut = s.find(';');
        if (cut != std::string::npos)
            s.resize(cut);
        while (!s.empty() && (s.back() == ' ' || s.back() == '\t'))
            s.pop_back();
        return s;
    }

    void WriteIni(const wchar_t* key, const std::string& value)
    {
        wchar_t buf[128] = {};
        MultiByteToWideChar(CP_UTF8, 0, value.c_str(), -1, buf, 128);
        if (!WritePrivateProfileStringW(L"hub", key, buf, g_ini.c_str()))
            Log("net: could not write %ls to the ini (%lu)", key, GetLastError());
    }

    std::string NewSecret()
    {
        unsigned char b[16];
        if (BCryptGenRandom(nullptr, b, sizeof(b), BCRYPT_USE_SYSTEM_PREFERRED_RNG) != 0)
            return {};
        static const char* hex = "0123456789abcdef";
        std::string s;
        for (unsigned char c : b)
        {
            s += hex[c >> 4];
            s += hex[c & 15];
        }
        return s;
    }

    std::string Field(const std::string& line, int n)
    {
        size_t at = 0;
        for (int i = 0; i < n; ++i)
        {
            at = line.find('\t', at);
            if (at == std::string::npos)
                return {};
            ++at;
        }
        const size_t end = line.find('\t', at);
        return line.substr(at, end == std::string::npos ? std::string::npos : end - at);
    }

    void SendNow(const std::string& line)
    {
        EnterCriticalSection(&g_wsLock);
        if (g_ws)
            WinHttpWebSocketSend(g_ws, WINHTTP_WEB_SOCKET_UTF8_MESSAGE_BUFFER_TYPE,
                                 const_cast<char*>(line.data()), static_cast<DWORD>(line.size()));
        LeaveCriticalSection(&g_wsLock);
    }

    // Under g_lock: it reads g_realm, which the render thread can change.
    std::string HelloLine(const std::string& nick)
    {
        return "HELLO\t" + nick + "\t" + g_secret + "\t" + kVersion + "\t" + g_realm;
    }

    // A line from the hub, looked at before Lua gets it. Called on the connection thread.
    void Inspect(const std::string& line)
    {
        const std::string kind = Field(line, 0);
        EnterCriticalSection(&g_lock);
        if (kind == "WELCOME")
        {
            g_onlineNick = g_nick = Field(line, 1);
            if (g_savedNick != g_onlineNick)
            {
                g_savedNick = g_onlineNick;
                WriteIni(L"nick", g_savedNick);
            }
            g_state.clear();          // so the state line goes out again with the new nick
            SetStateLocked("online");
        }
        else if (kind == "MSG" || kind == "HIST")
        {
            if (g_ring.size() >= kRing)
                g_ring.pop_front();
            g_ring.push_back("HIST" + line.substr(kind.size()));
        }
        else if (kind == "ERR")
        {
            const std::string code = Field(line, 1);
            if (code == "banned" || code == "replaced")
            {
                g_stop = code;
                g_dropSocket = true;
            }
            else if ((code == "taken" || code == "nick") && g_onlineNick.empty())
            {
                // The first HELLO on this socket was refused. If that was the saved nick, it is gone.
                if (g_nick == g_savedNick)
                {
                    g_savedNick.clear();
                    WriteIni(L"nick", "");
                }
                g_nick = g_savedNick;
                if (g_nick.empty())
                    g_dropSocket = true;
                else
                    g_out.push_front(HelloLine(g_nick));
            }
            else if (code == "taken" || code == "nick")
            {
                g_nick = g_onlineNick;   // a rename was refused; still online under the old one
            }
        }
        LeaveCriticalSection(&g_lock);
        SetEvent(g_sendEvent);
    }

    struct Url
    {
        bool          secure = false;
        std::wstring  host;
        INTERNET_PORT port   = 0;
        std::wstring  path;
    };

    // ws://host[:port]/path or wss://host[:port]/path. WinHttpCrackUrl does not know these schemes.
    bool ParseUrl(const wchar_t* text, Url& u)
    {
        std::wstring s(text);
        size_t at = 0;
        if (s.compare(0, 6, L"wss://") == 0)
        {
            u.secure = true;
            at = 6;
        }
        else if (s.compare(0, 5, L"ws://") == 0)
        {
            at = 5;
        }
        else
        {
            return false;
        }
        const size_t slash = s.find(L'/', at);
        std::wstring hostPort = s.substr(at, slash == std::wstring::npos ? std::wstring::npos : slash - at);
        u.path = slash == std::wstring::npos ? L"/" : s.substr(slash);
        const size_t colon = hostPort.find(L':');
        if (colon != std::wstring::npos)
        {
            u.host = hostPort.substr(0, colon);
            u.port = static_cast<INTERNET_PORT>(_wtoi(hostPort.c_str() + colon + 1));
        }
        else
        {
            u.host = hostPort;
            u.port = u.secure ? INTERNET_DEFAULT_HTTPS_PORT : INTERNET_DEFAULT_HTTP_PORT;
        }
        return !u.host.empty() && u.port != 0;
    }

    // One connection, from connect to failure. Returns true when it got as far as an open socket.
    bool RunOnce(HINTERNET session, const Url& u, const std::string& nick)
    {
        bool opened = false;
        HINTERNET conn = WinHttpConnect(session, u.host.c_str(), u.port, 0);
        HINTERNET req  = conn ? WinHttpOpenRequest(conn, L"GET", u.path.c_str(), nullptr, WINHTTP_NO_REFERER,
                                                   WINHTTP_DEFAULT_ACCEPT_TYPES,
                                                   u.secure ? WINHTTP_FLAG_SECURE : 0)
                              : nullptr;
        HINTERNET ws   = nullptr;
        if (!req)
        {
            Log("net: could not open a request (%lu)", GetLastError());
        }
        else if (!WinHttpSetOption(req, WINHTTP_OPTION_UPGRADE_TO_WEB_SOCKET, nullptr, 0) ||
                 !WinHttpSendRequest(req, WINHTTP_NO_ADDITIONAL_HEADERS, 0, nullptr, 0, 0, 0) ||
                 !WinHttpReceiveResponse(req, nullptr))
        {
            Log("net: connect failed (%lu)", GetLastError());
        }
        else
        {
            DWORD status = 0, size = sizeof(status);
            WinHttpQueryHeaders(req, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER, nullptr, &status, &size,
                                nullptr);
            ws = status == 101 ? WinHttpWebSocketCompleteUpgrade(req, 0) : nullptr;
            if (!ws)
                Log("net: the hub did not accept the WebSocket (HTTP %lu, error %lu)", status, GetLastError());
        }
        if (req)
            WinHttpCloseHandle(req);

        if (ws)
        {
            opened = true;
            EnterCriticalSection(&g_lock);
            g_ring.clear();                 // the hub sends its backlog again after HELLO
            g_onlineNick.clear();
            g_dropSocket = false;
            SetStateLocked("connected");
            const std::string hello = HelloLine(nick);
            LeaveCriticalSection(&g_lock);
            EnterCriticalSection(&g_wsLock);
            g_ws = ws;
            LeaveCriticalSection(&g_wsLock);
            Log("net: connected, HELLO as %s", nick.c_str());
            SendNow(hello);                 // before anything queued
            SetEvent(g_sendEvent);

            std::string msg;
            char buf[4096];
            for (;;)
            {
                DWORD read = 0;
                WINHTTP_WEB_SOCKET_BUFFER_TYPE type;
                const DWORD err = WinHttpWebSocketReceive(ws, buf, sizeof(buf), &read, &type);
                if (err != NO_ERROR)
                {
                    Log("net: receive failed (%lu)", err);
                    break;
                }
                if (type == WINHTTP_WEB_SOCKET_CLOSE_BUFFER_TYPE)
                {
                    Log("net: the hub closed the connection");
                    break;
                }
                msg.append(buf, read);
                if (msg.size() > 64 * 1024)
                {
                    Log("net: a message over 64 KB, dropping the connection");
                    break;
                }
                if (type == WINHTTP_WEB_SOCKET_UTF8_MESSAGE_BUFFER_TYPE ||
                    type == WINHTTP_WEB_SOCKET_BINARY_MESSAGE_BUFFER_TYPE)
                {
                    Inspect(msg);
                    PushIn(msg);
                    msg.clear();
                    EnterCriticalSection(&g_lock);
                    const bool drop = g_dropSocket;
                    LeaveCriticalSection(&g_lock);
                    if (drop)
                        break;
                }
            }

            EnterCriticalSection(&g_wsLock);
            g_ws = nullptr;
            WinHttpWebSocketClose(ws, WINHTTP_WEB_SOCKET_SUCCESS_CLOSE_STATUS, nullptr, 0);
            WinHttpCloseHandle(ws);
            LeaveCriticalSection(&g_wsLock);
            EnterCriticalSection(&g_lock);
            g_onlineNick.clear();
            LeaveCriticalSection(&g_lock);
        }
        if (conn)
            WinHttpCloseHandle(conn);
        return opened;
    }

    DWORD WINAPI ConnectionThread(LPVOID)
    {
        Url u;
        if (!ParseUrl(g_cfg.hubUrl, u))
        {
            Log("net: [hub] url is not a ws:// or wss:// address, so there is no connection");
            SetState("badurl");
            return 0;
        }
        HINTERNET session = WinHttpOpen(L"comfyaim/0.1", WINHTTP_ACCESS_TYPE_DEFAULT_PROXY, WINHTTP_NO_PROXY_NAME,
                                        WINHTTP_NO_PROXY_BYPASS, 0);
        if (!session)
        {
            Log("net: WinHttpOpen failed (%lu)", GetLastError());
            SetState("badurl");
            return 0;
        }
        DWORD wait = 2000;
        for (;;)
        {
            EnterCriticalSection(&g_lock);
            const std::string nick = g_nick, stop = g_stop;
            if (!stop.empty())
                SetStateLocked(stop.c_str());
            else if (nick.empty())
                SetStateLocked("nonick");
            else
                SetStateLocked("connecting");
            LeaveCriticalSection(&g_lock);
            if (!stop.empty() || nick.empty())
            {
                WaitForSingleObject(g_wake, INFINITE);
                wait = 2000;
                continue;
            }

            if (RunOnce(session, u, nick))
                wait = 2000;
            EnterCriticalSection(&g_lock);
            const bool stopped = !g_stop.empty();
            if (!stopped && !g_nick.empty())
                SetStateLocked("offline");
            LeaveCriticalSection(&g_lock);
            if (stopped)
                continue;   // straight to the stop state, not a reconnect wait first
            WaitForSingleObject(g_wake, wait);
            wait = wait * 2 > 60000 ? 60000 : wait * 2;
        }
    }

    DWORD WINAPI SendThread(LPVOID)
    {
        for (;;)
        {
            WaitForSingleObject(g_sendEvent, INFINITE);
            for (;;)
            {
                std::string line;
                EnterCriticalSection(&g_lock);
                if (!g_out.empty())
                {
                    line = g_out.front();
                    g_out.pop_front();
                }
                LeaveCriticalSection(&g_lock);
                if (line.empty())
                    break;

                EnterCriticalSection(&g_wsLock);
                const DWORD err = g_ws ? WinHttpWebSocketSend(g_ws, WINHTTP_WEB_SOCKET_UTF8_MESSAGE_BUFFER_TYPE,
                                                              &line[0], static_cast<DWORD>(line.size()))
                                       : ERROR_NOT_CONNECTED;
                LeaveCriticalSection(&g_wsLock);
                if (err != NO_ERROR)
                {
                    Log("net: send failed (%lu)", err);
                    if (line.compare(0, 4, "SAY\t") == 0)
                        PushIn("LOCAL\tnotsent\t" + line.substr(4));
                }
            }
        }
    }
}

void NetStart(const wchar_t* iniPath)
{
    InitializeCriticalSection(&g_lock);
    InitializeCriticalSection(&g_wsLock);
    g_sendEvent = CreateEventW(nullptr, FALSE, FALSE, nullptr);
    g_wake      = CreateEventW(nullptr, FALSE, FALSE, nullptr);
    g_ini = iniPath;

    g_secret = ReadIni(L"secret");
    if (g_secret.size() < 32)
    {
        g_secret = NewSecret();
        WriteIni(L"secret", g_secret);
        Log("net: made a new secret");
    }
    g_nick = g_savedNick = ReadIni(L"nick");
    g_realm = ReadIni(L"realm");
    if (ReadIni(L"online") == "0")
        g_stop = "signedoff";   // signed off last session: wait for Sign On
    Log("net: hub %ls, nick \"%s\"", g_cfg.hubUrl, g_nick.c_str());

    HANDLE a = CreateThread(nullptr, 0, ConnectionThread, nullptr, 0, nullptr);
    HANDLE b = CreateThread(nullptr, 0, SendThread, nullptr, 0, nullptr);
    if (a) CloseHandle(a);
    if (b) CloseHandle(b);
}

void NetSend(const std::string& line)
{
    if (line.empty())
        return;
    EnterCriticalSection(&g_lock);
    if (g_out.size() >= kMaxQueued)
        g_out.pop_front();
    g_out.push_back(line);
    LeaveCriticalSection(&g_lock);
    SetEvent(g_sendEvent);
}

void NetCommand(const std::string& cmd)
{
    const std::string verb = Field(cmd, 0);
    EnterCriticalSection(&g_lock);
    if (verb == "nick")
    {
        g_nick = Field(cmd, 1);
        if (g_ws && !g_nick.empty())
        {
            g_out.push_back(HelloLine(g_nick));   // the hub treats a second HELLO as a rename
            SetEvent(g_sendEvent);
        }
        else
        {
            SetEvent(g_wake);
        }
    }
    else if (verb == "realm")
    {
        const std::string realm = Field(cmd, 1);
        if (realm != g_realm)
        {
            g_realm = realm;
            WriteIni(L"realm", realm);
            if (!g_onlineNick.empty())
            {
                g_out.push_back(HelloLine(g_onlineNick));   // the same nick again: only the realm changes
                SetEvent(g_sendEvent);
            }
        }
    }
    else if (verb == "signon" || verb == "reconnect")
    {
        g_stop.clear();
        WriteIni(L"online", "1");
        SetEvent(g_wake);
    }
    else if (verb == "signoff")
    {
        // The choice is kept, so the next start stays signed off. The socket is shut from here with a
        // close frame; the hub answers it, the blocked receive returns CLOSE, and the connection thread
        // goes to the stop state without a reconnect wait.
        g_stop = "signedoff";
        g_dropSocket = true;
        WriteIni(L"online", "0");
        LeaveCriticalSection(&g_lock);
        EnterCriticalSection(&g_wsLock);
        if (g_ws)
            WinHttpWebSocketShutdown(g_ws, WINHTTP_WEB_SOCKET_SUCCESS_CLOSE_STATUS, nullptr, 0);
        LeaveCriticalSection(&g_wsLock);
        SetEvent(g_wake);
        return;
    }
    else if (verb == "state")
    {
        PushInLocked(StateLineLocked());
    }
    LeaveCriticalSection(&g_lock);
}

bool NetPoll(std::string& line)
{
    EnterCriticalSection(&g_lock);
    const bool any = !g_in.empty();
    if (any)
    {
        line = g_in.front();
        g_in.pop_front();
    }
    LeaveCriticalSection(&g_lock);
    return any;
}

std::vector<std::string> NetSnapshot()
{
    EnterCriticalSection(&g_lock);
    std::vector<std::string> out;
    out.push_back(StateLineLocked());
    out.insert(out.end(), g_ring.begin(), g_ring.end());
    g_in.clear();
    LeaveCriticalSection(&g_lock);
    return out;
}
