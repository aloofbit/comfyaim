-- ComfyAim: one chat room shared by players on any server.
--
-- 1.12 Lua cannot open a socket, so comfyaim.dll holds the connection. The two talk like this:
--
--   addon to DLL  SetCVar("comfyAimOut", "<seq>\t<line>"). The DLL reads it a few times a second and
--                 answers ComfyAim_Ack(seq). Only then does the addon clear it and write the next line,
--                 so lines typed fast are not lost between two reads.
--   DLL to addon  the DLL runs ComfyAim_OnLine("<line>") in this Lua state.
--
-- A line is fields split by a tab. The hub's lines are listed at the top of hub/server.js. The DLL adds
-- LOCAL lines of its own: "LOCAL state <state> <nick>" and "LOCAL notsent <text>". A line that starts
-- "DLL" goes to the DLL and not the hub: "DLL nick <name>", "DLL realm <name>", "DLL signon",
-- "DLL signoff".
--
-- Text from the hub is shown with every | doubled, so nobody can draw colours, links or textures in
-- somebody else's chat frame.
--
-- /a TALKS and /aim is FOR EVERYTHING ELSE, and the two never mix: a line in /a is always said, and
-- /aim never says anything. /a is a CHAT TYPE, not only a slash command: ChatEdit_ParseText checks
-- ChatTypeInfo before SlashCmdList, so with an entry here "/a " turns the chat box into an AIM box the
-- way "/p " does for party, and it stays that way after Enter (sticky). SendChatMessage is wrapped to
-- catch that type. The price: this client also has /a as a short /assist. /assist itself still works.

local ADDON = "ComfyAim"
local GOLD = "|cffffd200"
local BLUE = "|cff66ccff"
local GREY = "|cff999999"
local RED = "|cffff5555"

local state, nick, count = "waiting", "", 0
local buddies = {}                        -- { n = nick, r = realm }, sorted by nick
local queue, waiting, waitingSince = {}, nil, 0
local seq = math.floor(GetTime() * 10)   -- so a /reload never reuses the last seq the DLL saw
local seen, seenOrder = {}, {}
local autoNickTried = false

ChatTypeInfo["COMFYAIM"] = { r = 0.4, g = 0.8, b = 1.0, sticky = 1 }
CHAT_COMFYAIM_SEND = "AIM: "
SLASH_COMFYAIM1 = "/a"

-- ------------------------------------------------------------------------------------------------
-- helpers

local function Split(s)
	local t, start = {}, 1
	while true do
		local i = string.find(s, "\t", start, true)
		if not i then
			table.insert(t, string.sub(s, start))
			return t
		end
		table.insert(t, string.sub(s, start, i - 1))
		start = i + 1
	end
end

local function Safe(text)
	return (string.gsub(text or "", "|", "||"))
end

local function ChatFrame()
	if ComfyAimDB.frame == 0 then return nil end
	return getglobal("ChatFrame" .. (ComfyAimDB.frame or 1)) or DEFAULT_CHAT_FRAME
end

local function Say(text)
	DEFAULT_CHAT_FRAME:AddMessage(GOLD .. "[AIM]|r " .. text)
end

local function Clock(ts)
	if not date or not ts then return "" end
	return GREY .. date("%H:%M", ts) .. "|r "
end

-- A nick with its realm after it in grey, when there is one.
local function Who(n, realm)
	if realm and realm ~= "" then
		return BLUE .. Safe(n) .. "|r " .. GREY .. "(" .. Safe(realm) .. ")|r"
	end
	return BLUE .. Safe(n) .. "|r"
end

-- comfyAimIn and not comfyAimOut: GetCVar gives nil for an empty value, and comfyAimOut is empty
-- whenever nothing is on its way. The DLL writes a number into comfyAimIn when the world loads.
local function DllPresent()
	local ok, v = pcall(GetCVar, "comfyAimIn")
	return ok and v ~= nil and v ~= ""
end

local function Ignored(n)
	return n and ComfyAimDB.ignore[string.lower(n)]
end

-- ------------------------------------------------------------------------------------------------
-- the way out

local function Pump()
	if waiting or table.getn(queue) == 0 then return end
	if not DllPresent() then
		queue = {}
		return
	end
	seq = seq + 1
	waiting, waitingSince = seq, GetTime()
	SetCVar("comfyAimOut", seq .. "\t" .. queue[1])
end

local function Push(line)
	table.insert(queue, line)
	Pump()
end

function ComfyAim_Ack(n)
	if n ~= waiting then return end
	table.remove(queue, 1)
	waiting = nil
	SetCVar("comfyAimOut", "")
	Pump()
end

-- ------------------------------------------------------------------------------------------------
-- the window

local win, log, statusText, list, buddyTitle, input, signButton
local buddyRows = {}
local MAX_ROWS = 60
local ROW_HEIGHT = 14
local friendsButton, friendsBadge

local function StatusLine()
	if state == "online" then return "Online as " .. nick end
	if state == "connecting" or state == "connected" then return "Connecting" end
	if state == "offline" then return "Offline. Trying again." end
	if state == "nonick" then return "Pick a nick: /aim nick <name>" end
	if state == "banned" then return "Banned from the hub." end
	if state == "replaced" then return "Signed on from another client." end
	if state == "signedoff" then return "Signed off." end
	if state == "badurl" then return "Bad hub address in comfyaim.ini." end
	if state == "waiting" then return "Waiting for comfyaim.dll." end
	return "comfyaim.dll is not loaded."
end

-- True while comfyaim is on or trying to be: then the button offers Sign Off. After a sign off, a
-- ban or another client taking the nick, it offers Sign On.
local function SignedOnOrTrying()
	return state == "online" or state == "connecting" or state == "connected" or state == "offline"
		or state == "nonick"
end

local function SignOnOff(on)
	Push(on and "DLL\tsignon" or "DLL\tsignoff")
end

local function VisibleRows()
	if not list then return 0 end
	local n = math.floor((list:GetHeight() - 28) / ROW_HEIGHT)
	if n < 1 then return 1 end
	if n > MAX_ROWS then return MAX_ROWS end
	return n
end

local function Refresh()
	local online = state == "online"
	if statusText then
		statusText:SetText((online and "|cff33ff33" or GREY) .. StatusLine() .. "|r")
		signButton:SetText(SignedOnOrTrying() and "Sign Off" or "Sign On")
		if state == "waiting" or state == "nodll" or state == "badurl" then
			signButton:Disable()
		else
			signButton:Enable()
		end
		local n = table.getn(buddies)
		buddyTitle:SetText("Online (" .. n .. ")")
		local rows = VisibleRows()
		for i = 1, MAX_ROWS do
			local row = buddyRows[i]
			local b = buddies[i]
			row.buddy = nil
			if i > rows then
				row:Hide()
			elseif i == rows and n > rows then
				row.text:SetText(GREY .. "+" .. (n - rows + 1) .. " more|r")
				row:Show()
			elseif b then
				local colour = Ignored(b.n) and GREY or (b.n == nick and GOLD or "|cffffffff")
				row.text:SetText(colour .. b.n .. "|r")
				row.buddy = b
				row:Show()
			else
				row:Hide()
			end
		end
	end
	if friendsBadge then
		friendsBadge:SetText(online and tostring(table.getn(buddies)) or "")
		local tex = friendsButton:GetNormalTexture()
		if tex.SetDesaturated then tex:SetDesaturated(not online) end
	end
end

local function AddToWindow(text)
	if log then log:AddMessage(text) end
end

local function SendText(text)
	text = string.gsub(text or "", "[\t\r\n]", " ")
	if text == "" then return end
	if state ~= "online" then
		Say(RED .. "Not signed on.|r " .. StatusLine())
		return
	end
	Push("SAY\t" .. text)
end

local function SavePlace()
	local point, _, rel, x, y = win:GetPoint()
	ComfyAimDB.pos = { point, rel, x, y }
	ComfyAimDB.size = { win:GetWidth(), win:GetHeight() }
end

-- A flat one pixel border, the same grey on all four sides. Not the tooltip border: that one is lit on
-- its right edge and dark on its left, so two panels side by side met bright edge to dark edge and read
-- as two different styles. The solid texture is the chat window's own background, which every 1.12
-- client has; WHITE8X8 would do the same but is in Turtle's patch-I only.
local panels = {}

local function Panel(parent)
	local f = CreateFrame("Frame", nil, parent)
	table.insert(panels, f)
	f:SetBackdrop({
		bgFile = "Interface\\ChatFrame\\ChatFrameBackground",
		edgeFile = "Interface\\ChatFrame\\ChatFrameBackground",
		tile = false, edgeSize = 1,
		insets = { left = 1, right = 1, top = 1, bottom = 1 },
	})
	f:SetBackdropColor(0, 0, 0, 0.55)
	f:SetBackdropBorderColor(0.5, 0.5, 0.5, 0.9)
	return f
end

-- A 1.12 EditBox keeps keyboard focus until something takes it away, and a click in the 3D world raises
-- nothing an addon can see: after typing, W A S D went into the box as letters. So a full-screen catcher
-- at BACKGROUND strata (above the world, below every piece of UI) is up while the box has focus, and a
-- click on it lets the focus go. It costs that one click, the same as ComfyHousingDev's; the free route
-- through CameraOrSelectOrMoveStart is protected and blocked. The window, its rows and its grip let the
-- focus go themselves.
local catcher

local function Defocus()
	if input then input:ClearFocus() end
	if catcher then catcher:Hide() end
end

-- The corner grip: six dots in a triangle, the usual sign for "drag to resize". This client has no
-- size-grabber texture, so the dots are plain coloured squares.
local function BuildGrip()
	local grip = CreateFrame("Button", "ComfyAimFrameGrip", win)
	grip:SetWidth(16)
	grip:SetHeight(16)
	grip:SetPoint("BOTTOMRIGHT", win, "BOTTOMRIGHT", -5, 5)
	grip:SetFrameLevel(win:GetFrameLevel() + 5)
	local dots = { { 12, 0 }, { 8, 0 }, { 4, 0 }, { 12, 4 }, { 8, 4 }, { 12, 8 } }
	for _, d in ipairs(dots) do
		local t = grip:CreateTexture(nil, "OVERLAY")
		t:SetTexture(1, 0.82, 0, 0.8)
		t:SetWidth(2)
		t:SetHeight(2)
		t:SetPoint("BOTTOMLEFT", grip, "BOTTOMLEFT", d[1], d[2] + 2)
	end
	grip:SetScript("OnMouseDown", function()
		Defocus()
		win:StartSizing("BOTTOMRIGHT")
	end)
	grip:SetScript("OnMouseUp", function()
		win:StopMovingOrSizing()
		SavePlace()
	end)
end

local function BuildWindow()
	win = CreateFrame("Frame", "ComfyAimFrame", UIParent)
	local size = ComfyAimDB.size
	win:SetWidth(size and size[1] or 460)
	win:SetHeight(size and size[2] or 320)
	win:SetFrameStrata("DIALOG")
	win:SetToplevel(true)
	win:SetMovable(true)
	win:SetResizable(true)
	win:SetMinResize(380, 220)
	win:SetMaxResize(1200, 900)
	win:EnableMouse(true)
	if win.SetClampedToScreen then win:SetClampedToScreen(true) end
	win:RegisterForDrag("LeftButton")
	win:SetScript("OnDragStart", function() this:StartMoving() end)
	win:SetScript("OnDragStop", function()
		this:StopMovingOrSizing()
		SavePlace()
	end)
	win:SetScript("OnSizeChanged", function() Refresh() end)
	win:SetBackdrop({
		bgFile = "Interface\\DialogFrame\\UI-DialogBox-Background",
		edgeFile = "Interface\\DialogFrame\\UI-DialogBox-Border",
		tile = true, tileSize = 32, edgeSize = 32,
		insets = { left = 11, right = 12, top = 12, bottom = 11 },
	})
	local p = ComfyAimDB.pos
	if p then
		win:SetPoint(p[1], UIParent, p[2], p[3], p[4])
	else
		win:SetPoint("CENTER", UIParent, "CENTER", 0, 60)
	end
	win:Hide()
	tinsert(UISpecialFrames, "ComfyAimFrame")

	local title = win:CreateFontString(nil, "ARTWORK", "GameFontNormalLarge")
	title:SetPoint("TOPLEFT", win, "TOPLEFT", 20, -18)
	title:SetText("AIM")

	statusText = win:CreateFontString(nil, "ARTWORK", "GameFontHighlightSmall")
	statusText:SetPoint("LEFT", title, "RIGHT", 10, -1)

	local close = CreateFrame("Button", "ComfyAimFrameClose", win, "UIPanelCloseButton")
	close:SetPoint("TOPRIGHT", win, "TOPRIGHT", -6, -6)

	signButton = CreateFrame("Button", "ComfyAimFrameSignOn", win, "UIPanelButtonTemplate")
	signButton:SetWidth(80)
	signButton:SetHeight(20)
	signButton:SetPoint("RIGHT", close, "LEFT", -2, 1)
	signButton:SetScript("OnClick", function()
		Defocus()
		SignOnOff(not SignedOnOrTrying())
	end)

	-- the buddy list, right
	list = Panel(win)
	list:SetWidth(130)
	list:SetPoint("TOPRIGHT", win, "TOPRIGHT", -16, -44)
	list:SetPoint("BOTTOMRIGHT", win, "BOTTOMRIGHT", -16, 22)
	buddyTitle = list:CreateFontString(nil, "ARTWORK", "GameFontNormalSmall")
	buddyTitle:SetPoint("TOPLEFT", list, "TOPLEFT", 8, -8)
	for i = 1, MAX_ROWS do
		local row = CreateFrame("Button", "ComfyAimBuddy" .. i, list)
		row:SetWidth(114)
		row:SetHeight(ROW_HEIGHT)
		row:SetPoint("TOPLEFT", list, "TOPLEFT", 8, -10 - i * ROW_HEIGHT)
		row.text = row:CreateFontString(nil, "ARTWORK", "GameFontHighlightSmall")
		row.text:SetAllPoints(row)
		row.text:SetJustifyH("LEFT")
		row:SetScript("OnEnter", function()
			local b = this.buddy
			if not b then return end
			GameTooltip:SetOwner(this, "ANCHOR_LEFT")
			GameTooltip:SetText(b.n)
			GameTooltip:AddLine(b.r ~= "" and b.r or "Realm unknown", 0.6, 0.6, 0.6)
			if Ignored(b.n) then GameTooltip:AddLine("Ignored", 1, 0.3, 0.3) end
			GameTooltip:Show()
		end)
		row:SetScript("OnLeave", function() GameTooltip:Hide() end)
		row:SetScript("OnMouseDown", Defocus)
		row:Hide()
		buddyRows[i] = row
	end

	-- the input, bottom left: the same panel as the room above it, so the two read as one column
	local box = Panel(win)
	box:SetHeight(28)
	box:SetPoint("BOTTOMLEFT", win, "BOTTOMLEFT", 16, 22)
	box:SetPoint("BOTTOMRIGHT", list, "BOTTOMLEFT", -6, 0)

	-- the room, left, down to the input
	local pane = Panel(win)
	pane:SetPoint("TOPLEFT", win, "TOPLEFT", 16, -44)
	pane:SetPoint("BOTTOMRIGHT", box, "TOPRIGHT", 0, 4)

	log = CreateFrame("ScrollingMessageFrame", nil, pane)
	log:SetPoint("TOPLEFT", pane, "TOPLEFT", 8, -8)
	log:SetPoint("BOTTOMRIGHT", pane, "BOTTOMRIGHT", -8, 8)
	log:SetFontObject(ChatFontNormal)
	log:SetJustifyH("LEFT")
	log:SetMaxLines(300)
	log:SetFading(false)
	log:EnableMouseWheel(true)
	log:SetScript("OnMouseWheel", function()
		if arg1 > 0 then
			if IsShiftKeyDown() then this:ScrollToTop() else this:ScrollUp() end
		else
			if IsShiftKeyDown() then this:ScrollToBottom() else this:ScrollDown() end
		end
	end)

	input = CreateFrame("EditBox", "ComfyAimFrameInput", box)
	input:SetPoint("TOPLEFT", box, "TOPLEFT", 8, -4)
	input:SetPoint("BOTTOMRIGHT", box, "BOTTOMRIGHT", -8, 4)
	input:SetFontObject(ChatFontNormal)
	local c = ChatTypeInfo["COMFYAIM"]
	input:SetTextColor(c.r, c.g, c.b)
	input:SetAutoFocus(false)
	input:SetMaxLetters(255)
	input:SetHistoryLines(32)
	box:EnableMouse(true)
	box:SetScript("OnMouseDown", function() input:SetFocus() end)

	catcher = CreateFrame("Frame", "ComfyAimCatcher", UIParent)
	catcher:SetAllPoints(UIParent)
	catcher:SetFrameStrata("BACKGROUND")
	catcher:EnableMouse(true)
	catcher:Hide()
	catcher:SetScript("OnMouseDown", Defocus)
	input:SetScript("OnEditFocusGained", function() catcher:Show() end)
	input:SetScript("OnEditFocusLost", function() catcher:Hide() end)
	win:SetScript("OnMouseDown", Defocus)
	win:SetScript("OnHide", Defocus)
	input:SetScript("OnEnterPressed", function()
		local text = this:GetText()
		if text ~= "" then this:AddHistoryLine(text) end
		SendText(text)
		this:SetText("")
	end)
	input:SetScript("OnEscapePressed", function() this:ClearFocus() end)

	BuildGrip()
	Refresh()
end

-- ShaguTweaks' Darkened UI darkens by walking UIParent ONCE, when the module turns on
-- (mods/dark-ui-elements.lua). The window is built the first time it opens, after that walk, so it has
-- to ask. DarkenFrame skips solid textures and icons by name, so the grip dots and the friends button
-- keep their colour; what it changes is the borders and the dialog frame.
--
-- It also greys the panels' BACKGROUNDS: in 1.12 a backdrop is textures that GetRegions returns, and
-- DarkenFrame vertex-colours every one it does not skip, the black fill included. So the panels get
-- their own fill back afterwards and keep the darkened border.
local function Darken(frame)
	if ShaguTweaks and ShaguTweaks.DarkMode and ShaguTweaks.DarkenFrame then
		ShaguTweaks.DarkenFrame(frame)
		for _, p in ipairs(panels) do p:SetBackdropColor(0, 0, 0, 0.55) end
	end
end

local function Toggle()
	if not win then
		BuildWindow()
		Darken(win)
	end
	if win:IsVisible() then
		win:Hide()
	else
		win:Show()
		Refresh()
	end
end

-- The AIM button in the friends list: a square in the gap between Add Friend and Send Message, with
-- Sprint's running figure standing in for AIM's running man. The number is how many are online.
local function BuildFriendsButton()
	if friendsButton or not FriendsListFrame or not FriendsFrameAddFriendButton then return end
	local b = CreateFrame("Button", "ComfyAimFriendsButton", FriendsListFrame)
	b:SetWidth(40)
	b:SetHeight(40)
	b:SetPoint("LEFT", FriendsFrameAddFriendButton, "RIGHT", 13, -13)
	b:SetNormalTexture("Interface\\Icons\\Ability_Rogue_Sprint")
	b:SetPushedTexture("Interface\\Icons\\Ability_Rogue_Sprint")
	b:GetPushedTexture():SetTexCoord(0.08, 0.92, 0.08, 0.92)
	b:SetHighlightTexture("Interface\\Buttons\\ButtonHilight-Square")
	b:GetHighlightTexture():SetBlendMode("ADD")
	friendsBadge = b:CreateFontString(nil, "OVERLAY", "NumberFontNormal")
	friendsBadge:SetPoint("BOTTOMRIGHT", b, "BOTTOMRIGHT", -2, 2)
	b:SetScript("OnClick", Toggle)
	b:SetScript("OnEnter", function()
		GameTooltip:SetOwner(this, "ANCHOR_RIGHT")
		GameTooltip:SetText("AIM")
		GameTooltip:AddLine(StatusLine(), 1, 1, 1)
		GameTooltip:Show()
	end)
	b:SetScript("OnLeave", function() GameTooltip:Hide() end)
	friendsButton = b
	Refresh()
end

-- ------------------------------------------------------------------------------------------------
-- lines from the DLL

local function Seen(key)
	if seen[key] then return true end
	seen[key] = true
	table.insert(seenOrder, key)
	if table.getn(seenOrder) > 300 then
		seen[table.remove(seenOrder, 1)] = nil
	end
	return false
end

local function FindBuddy(n)
	local low = string.lower(n)
	for i = 1, table.getn(buddies) do
		if string.lower(buddies[i].n) == low then return i end
	end
end

-- True when n was not in the list before.
local function SetBuddy(n, on, realm)
	local i = FindBuddy(n)
	if i then table.remove(buddies, i) end
	if on then
		table.insert(buddies, { n = n, r = realm or "" })
		table.sort(buddies, function(a, b) return string.lower(a.n) < string.lower(b.n) end)
	end
	return not i
end

local function TryAutoNick()
	if autoNickTried or state ~= "nonick" then return end
	local me = UnitName("player")
	if not me or me == UNKNOWNOBJECT then return end
	autoNickTried = true
	Push("DLL\tnick\t" .. me)
end

local function SendRealm()
	local realm = GetRealmName and GetRealmName()
	if realm and realm ~= "" then
		Push("DLL\trealm\t" .. string.gsub(realm, "[\t\r\n]", " "))
	end
end

function ComfyAim_OnLine(line)
	local f = Split(line)
	local kind = f[1]

	if kind == "LOCAL" and f[2] == "state" then
		local was = state
		state, nick = f[3] or "offline", f[4] or ""
		if state ~= "online" then buddies = {} end
		if was == "online" and state == "offline" then
			Say(GREY .. "Lost the hub. Trying again.|r")
			AddToWindow(GREY .. "Lost the hub. Trying again.|r")
		elseif state == "replaced" or state == "banned" then
			Say(RED .. StatusLine() .. "|r")
		elseif state == "signedoff" and was ~= "signedoff" and was ~= "waiting" then
			Say(GREY .. "Signed off.|r")
			AddToWindow(GREY .. "Signed off.|r")
		end
		TryAutoNick()
		if state == "online" and was ~= "online" then Push("WHO") end
	elseif kind == "LOCAL" and f[2] == "notsent" then
		Say(RED .. "Not sent:|r " .. Safe(f[3]))
	elseif kind == "WELCOME" then
		nick, count = f[2] or nick, tonumber(f[3]) or 0
		Say("Signed on as " .. BLUE .. nick .. "|r. " .. count .. " online. " .. GREY .. "/a to talk.|r")
		AddToWindow(GREY .. "Signed on as " .. nick .. ".|r")
	elseif kind == "HIST" or kind == "MSG" then
		local ts, from, text, realm = f[2], f[3] or "?", f[4] or "", f[5]
		if Ignored(from) or Seen((ts or "") .. "\t" .. from .. "\t" .. text) then return end
		AddToWindow(Clock(tonumber(ts)) .. Who(from, realm) .. ": " .. Safe(text))
		local cf = kind == "MSG" and ChatFrame()
		if cf then
			local info = ChatTypeInfo["COMFYAIM"]
			cf:AddMessage("[AIM] [" .. Who(from, realm) .. "]: " .. Safe(text), info.r, info.g, info.b)
		end
	elseif kind == "JOIN" then
		if SetBuddy(f[2], true, f[3]) then
			AddToWindow(GREY .. Safe(f[2]) .. " signed on.|r")
		end
	elseif kind == "PART" then
		SetBuddy(f[2], false)
		AddToWindow(GREY .. Safe(f[2]) .. " signed off.|r")
	elseif kind == "WHO" then
		buddies = {}
		local i = 2
		while f[i] do
			if f[i] ~= "" then table.insert(buddies, { n = f[i], r = f[i + 1] or "" }) end
			i = i + 2
		end
	elseif kind == "SYS" then
		Say(Safe(f[2]))
		AddToWindow(GOLD .. Safe(f[2]) .. "|r")
	elseif kind == "ERR" then
		local code, text = f[2], Safe(f[3])
		if code == "taken" or code == "nick" then
			text = text .. " Pick one: /aim nick <name>"
		end
		Say(RED .. text .. "|r")
		AddToWindow(RED .. text .. "|r")
	end
	Refresh()
end

-- ------------------------------------------------------------------------------------------------
-- /a talks, /aim is for everything else

local function Help()
	Say("/a <text>: talk. /aim: the window.")
	Say("/aim nick <name>, /aim who, /aim ignore <nick>, /aim unignore <nick>")
	Say("/aim chat <1-7|off>: where the room shows in chat. /aim on, /aim off: sign on or off.")
end

local function OneWord(rest)
	return rest ~= "" and not string.find(rest, " ", 1, true)
end

-- /aim never talks: a line it does not know gets the help, so a typo in a command is not said aloud.
local function Command(msg)
	msg = string.gsub(msg or "", "^%s+", "")
	msg = string.gsub(msg, "%s+$", "")
	local _, _, word, rest = string.find(msg, "^(%S+)%s*(.*)$")
	word = string.lower(word or "")
	rest = rest or ""

	if msg == "" then
		Toggle()
	elseif not DllPresent() then
		Say(RED .. "comfyaim.dll is not loaded.|r Add it to dlls.txt and restart the client.")
	elseif word == "nick" and OneWord(rest) then
		Push("DLL\tnick\t" .. rest)
	elseif word == "who" and rest == "" then
		local names = {}
		for i = 1, table.getn(buddies) do table.insert(names, buddies[i].n) end
		Say(table.getn(names) .. " online: " .. (table.getn(names) > 0 and table.concat(names, ", ") or "nobody"))
	elseif (word == "on" or word == "off") and rest == "" then
		SignOnOff(word == "on")
	elseif word == "ignore" and OneWord(rest) then
		ComfyAimDB.ignore[string.lower(rest)] = true
		Say("Ignoring " .. Safe(rest) .. ".")
		Refresh()
	elseif word == "unignore" and OneWord(rest) then
		ComfyAimDB.ignore[string.lower(rest)] = nil
		Say("No longer ignoring " .. Safe(rest) .. ".")
		Refresh()
	elseif word == "chat" and OneWord(rest) then
		if rest == "off" then
			ComfyAimDB.frame = 0
			Say("The room shows only in the AIM window.")
		elseif tonumber(rest) and getglobal("ChatFrame" .. rest) then
			ComfyAimDB.frame = tonumber(rest)
			Say("The room shows in chat window " .. rest .. ".")
		else
			Say("/aim chat <1-7|off>")
		end
	elseif (word == "kick" or word == "ban" or word == "unban") and OneWord(rest) then
		Push("ADMIN\t" .. word .. "\t" .. rest)
	else
		Help()
	end
end

SLASH_COMFYAIMCMD1 = "/aim"
SlashCmdList["COMFYAIMCMD"] = Command

-- The chat box in AIM mode sends through here. Everything in it is talk, commands included.
local origSendChatMessage = SendChatMessage
SendChatMessage = function(msg, chatType, language, target)
	if chatType == "COMFYAIM" then
		SendText(msg)
		return
	end
	return origSendChatMessage(msg, chatType, language, target)
end

-- "/a" on its own, then Enter, leaves an empty box that never reaches SendChatMessage. That one opens
-- the window, the same as /aim.
local origParseText = ChatEdit_ParseText
ChatEdit_ParseText = function(editBox, send)
	local before = editBox:GetText()
	origParseText(editBox, send)
	if send == 1 and editBox.chatType == "COMFYAIM" then
		local cmd = string.lower((string.gsub(before or "", "%s", "")))
		if cmd == "/a" then Toggle() end
	end
end

-- For a chat addon that replaces ChatEdit_ParseText and never looks at ChatTypeInfo.
SlashCmdList["COMFYAIM"] = function(msg)
	if msg == nil or string.gsub(msg, "%s", "") == "" then Toggle() else SendText(msg) end
end

-- ------------------------------------------------------------------------------------------------
-- start-up

-- A new UI: tell the DLL, which then sends the state and the recent room. A /reload keeps the client's
-- Lua state, so without this the DLL cannot tell that everything the addon knew is gone.
pcall(SetCVar, "comfyAimIn", "0")

local events = CreateFrame("Frame")
events:RegisterEvent("ADDON_LOADED")
events:RegisterEvent("PLAYER_ENTERING_WORLD")
events:SetScript("OnEvent", function()
	if event == "ADDON_LOADED" and arg1 == ADDON then
		ComfyAimDB = ComfyAimDB or {}
		ComfyAimDB.ignore = ComfyAimDB.ignore or {}
		if ComfyAimDB.frame == nil then ComfyAimDB.frame = 1 end
		BuildFriendsButton()
	elseif event == "PLAYER_ENTERING_WORLD" then
		BuildFriendsButton()
		if not DllPresent() then
			state = "nodll"
			Refresh()
			return
		end
		SendRealm()
		TryAutoNick()
	end
end)

-- The DLL answers within a tenth of a second. Past three, it is not there, and waiting would hold every
-- later line.
events:SetScript("OnUpdate", function()
	if waiting and GetTime() - waitingSince > 3 then
		waiting = nil
		queue = {}
		SetCVar("comfyAimOut", "")
		Say(RED .. "comfyaim.dll is not answering.|r")
	end
end)
