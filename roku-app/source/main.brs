' main.brs — Roku Dev Toolkit Bridge Agent
' 
' This sideloaded app:
' 1. Opens a TCP connection to your PC toolkit server
' 2. Sends periodic device status reports
' 3. Acts as a remote command receiver
' 4. Monitors system metrics
' 5. Provides enhanced debugging hooks
'
' Configure the TARGET_HOST and TARGET_PORT below.

sub Main()
    ' Configuration — CHANGE THESE to point to your PC
    targetHost$ = "192.168.1.100"  ' Your PC's IP address
    targetPort% = 4701              ' Bridge port on your PC
    reportInterval% = 5000          ' Status report interval (ms)

    print "═══════════════════════════════════════════"
    print "  Roku Dev Toolkit Bridge Agent v1.0"
    print "  Target: "; targetHost$; ":"; targetPort%
    print "═══════════════════════════════════════════"

    ' Create SceneGraph screen (minimal UI)
    screen = CreateObject("roSGScreen")
    port = CreateObject("roMessagePort")
    screen.SetMessagePort(port)
    scene = screen.CreateScene("BridgeScene")
    screen.Show()

    ' ── Device Info Collection ──
    deviceInfo = CreateObject("roDeviceInfo")
    appInfo = CreateObject("roAppInfo")

    print "Device: "; deviceInfo.GetModel()
    print "OS: "; deviceInfo.GetVersion()

    ' ── TCP Bridge Connection ──
    bridge = CreateObject("roStreamSocket")
    bridge.SetMessagePort(port)
    bridgeActive = false

    sub connectBridge()
        addr = CreateObject("roSocketAddress")
        addr.SetAddress(targetHost$ + ":" + Str(targetPort%).Trim())
        bridge.SetActive(true)
        result = bridge.Connect()
        if result
            print "Bridge connected to "; targetHost$; ":"; targetPort%
            bridgeActive = true
            return true
        else
            print "Bridge connection failed"
            bridgeActive = false
            return false
        end if
    end sub

    connectBridge()

    ' ── Report Timer ──
    timer = CreateObject("roTimespan")

    ' ── Registry Access ──
    registry = CreateObject("roRegistry")
    regSection = CreateObject("roRegistrySection", "dev")

    ' ── Main Event Loop ──
    while true
        msg = Wait(reportInterval%, port)

        if type(msg) = "roSGScreenEvent"
            if msg.IsScreenClosed()
                exit while
            end if
        else if type(msg) = "roSocketEvent"
            if msg.GetSocketID() = bridge.GetID()
                if msg.IsConnectedEvent()
                    print "Bridge connected"
                    bridgeActive = true
                    ' Send handshake
                    handshake$ = BuildHandshake(deviceInfo)
                    bridge.SendStr(handshake$, Len(handshake$))
                else if msg.IsSendProgressEvent()
                    ' Data sent OK
                else if msg.IsReceiveProgressEvent()
                    ' Data received
                    data$ = bridge.ReceiveStr(4096)
                    if Len(data$) > 0
                        HandleCommand(data$, deviceInfo, appInfo, registry)
                    end if
                else if msg.IsConnectionClosed()
                    print "Bridge disconnected — reconnecting..."
                    bridgeActive = false
                    ' Reconnect after delay
                    Sleep(5000)
                    connectBridge()
                end if
            end if
        end if

        ' Periodic status report
        if bridgeActive
            report$ = BuildStatusReport(deviceInfo, appInfo, registry)
            result = bridge.SendStr(report$, Len(report$))
            if result <= 0
                print "Failed to send status — marking disconnected"
                bridgeActive = false
            end if
        else
            ' Try reconnecting periodically
            if bridgeActive = false
                print "Attempting reconnect..."
                connectBridge()
            end if
        end if
    end while

    ' Cleanup
    if bridgeActive then bridge.Close()
    print "Bridge Agent stopped"
end sub

' ─── Build Handshake ──────────────────────────────────────────
function BuildHandshake(deviceInfo as Object) as String
    handshake = {
        type: "handshake"
        agent: "Roku Dev Toolkit Bridge v1.0"
        model: deviceInfo.GetModel()
        serial: deviceInfo.GetDeviceUniqueId()
        osVersion: deviceInfo.GetVersion()
        firmware: deviceInfo.GetFirmwareVersion()
        memory: deviceInfo.GetTotalRAM()
        displayType: deviceInfo.GetDisplayType()
        displayMode: deviceInfo.GetDisplayMode()
        timestamp: CreateObject("roDateTime").AsSeconds().ToStr()
    }
    return FormatJSON(handshake)
end function

' ─── Build Status Report ──────────────────────────────────────
function BuildStatusReport(deviceInfo as Object, appInfo as Object, registry as Object) as String
    dt = CreateObject("roDateTime")
    dt.ToLocalTime()

    ' Get memory info
    memStats = CreateObject("roAppMemoryMonitor")
    memUsed = memStats.GetMemoryUsed()
    memMax = memStats.GetMemoryMax()

    ' Get network info
    networkInfo = {}
    if deviceInfo.GetLinkStatus()
        networkInfo.connected = true
        networkInfo.type = deviceInfo.GetConnectionType()
        networkInfo.ip = deviceInfo.GetExternalIp()
    else
        networkInfo.connected = false
    end if

    ' Get current app info
    currentApp$ = ""
    currentAppId$ = ""
    ' Note: roDeviceInfo doesn't expose current running app directly
    ' This will need ECP query from the PC side

    status = {
        type: "status_report"
        agent: "RokuTK Bridge"
        timestamp: dt.AsSeconds().ToStr()
        uptime: CreateObject("roTimespan").TotalSeconds().ToStr()
        device: {
            model: deviceInfo.GetModel()
            serial: deviceInfo.GetDeviceUniqueId()
            osVersion: deviceInfo.GetVersion()
            build: deviceInfo.GetFirmwareVersion()
            locale: deviceInfo.GetCurrentLocale()
            timezone: deviceInfo.GetTimeZone()
            country: deviceInfo.GetCountryCode()
            language: deviceInfo.GetPreferredCaptionLanguage()
        }
        display: {
            type: deviceInfo.GetDisplayType()
            mode: deviceInfo.GetDisplayMode()
            aspectRatio: deviceInfo.GetDisplayAspectRatio()
            hdr: deviceInfo.IsHDRDisplay()
            dolbyVision: deviceInfo.IsDolbyVisionSupported()
        }
        memory: {
            used: memUsed
            max: memMax
            totalRAM: deviceInfo.GetTotalRAM()
        }
        network: networkInfo
        audio: {
            type: deviceInfo.GetAudioOutputChannel()
            surround: deviceInfo.IsAudioGuideEnabled()
            passthrough: deviceInfo.IsAudioPassthroughSupported()
        }
        features: {
            ethernet: deviceInfo.IsEthernetSupported()
            wifi: deviceInfo.IsWiFiSupported()
            bluetooth: deviceInfo.IsBluetoothSupported()
            usb: deviceInfo.IsUSBSupported()
            sdCard: deviceInfo.IsSDCardSupported()
        }
        registry_size: registry.GetSectionList().Count()
    }
    return FormatJSON(status)
end function

' ─── Command Handler ──────────────────────────────────────────
sub HandleCommand(cmdJson$ as String, deviceInfo as Object, appInfo as Object, registry as Object)
    print "Received: "; Left(cmdJson$, 100)

    ' Parse JSON command (simplified parser for performance)
    ' Commands:
    '   {"cmd":"ping"}              — Simple ping
    '   {"cmd":"registry_read"}     — Read all registry
    '   {"cmd":"registry_write","key":"X","value":"Y"} — Write registry
    '   {"cmd":"reboot"}            — Reboot device
    '   {"cmd":"deep_sleep"}        — Deep sleep

    cmd = ParseJSON(cmdJson$)
    if cmd = invalid
        print "Invalid JSON command"
        return
    end if

    cmdType$ = ""
    if cmd.DoesExist("cmd")
        cmdType$ = cmd.cmd
    end if

    if cmdType$ = "ping"
        ' Already handled by status reports, but send ACK
        response$ = FormatJSON({type:"pong", timestamp:CreateObject("roDateTime").AsSeconds().ToStr()})
        bridge.SendStr(response$, Len(response$))

    else if cmdType$ = "registry_read"
        sections = registry.GetSectionList()
        regData = {}
        for each section$ in sections
            sec = CreateObject("roRegistrySection", section$)
            keys = sec.GetKeyList()
            secData = {}
            for each key$ in keys
                secData[key$] = sec.Read(key$)
            end for
            regData[section$] = secData
        end for
        response$ = FormatJSON({type:"registry_data", data:regData})

    else if cmdType$ = "registry_write"
        if cmd.DoesExist("key") and cmd.DoesExist("value")
            section$ = "dev"
            if cmd.DoesExist("section") then section$ = cmd.section
            sec = CreateObject("roRegistrySection", section$)
            sec.Write(cmd.key, cmd.value)
            sec.Flush()
            response$ = FormatJSON({type:"registry_write_ack", key:cmd.key, value:cmd.value, success:true})
        else
            response$ = FormatJSON({type:"error", message:"Missing key or value"})
        end if

    else if cmdType$ = "reboot"
        if cmd.DoesExist("confirm") and cmd.confirm = "yes"
            response$ = FormatJSON({type:"reboot_ack", message:"Rebooting in 3 seconds"})
            bridge.SendStr(response$, Len(response$))
            Sleep(3000)
            RebootSystem()
        else
            response$ = FormatJSON({type:"error", message:"Need confirm:'yes' to reboot"})
        end if

    else if cmdType$ = "device_info"
        info = {
            type: "device_info_response"
            model: deviceInfo.GetModel()
            serial: deviceInfo.GetDeviceUniqueId()
            osVersion: deviceInfo.GetVersion()
            firmware: deviceInfo.GetFirmwareVersion()
            ip: deviceInfo.GetExternalIp()
            mac: deviceInfo.GetLinkStatus()
            memory: deviceInfo.GetTotalRAM()
            display: deviceInfo.GetDisplayType()
            audio: deviceInfo.GetAudioOutputChannel()
        }
        response$ = FormatJSON(info)

    else
        response$ = FormatJSON({type:"error", message:"Unknown command: " + cmdType$})
    end if

    ' Send response
    if response$ <> ""
        bridge.SendStr(response$, Len(response$))
    end if
end sub
