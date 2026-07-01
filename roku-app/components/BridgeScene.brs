' BridgeScene.brs — Scene logic for the RokuTK Bridge Agent
'
' Provides a minimal UI overlay showing connection status
' and device information while the bridge runs.

sub init()
    m.top.setFocus(true)
    m.top.backgroundURI = ""
    m.top.backgroundColor = "&h0D1117FF"
    
    m.statusLabel = m.top.FindNode("statusLabel")
    m.deviceLabel = m.top.FindNode("deviceLabel")
    m.ipLabel = m.top.FindNode("ipLabel")
    m.background = m.top.FindNode("background")
    
    ' Get device info
    deviceInfo = CreateObject("roDeviceInfo")
    m.deviceLabel.text = "Device: " + deviceInfo.GetModel()
    
    ' Show version info
    m.statusLabel.text = "RokuTK Bridge Agent v1.0"
    
    ' Background will be handled by main.brs
    print "BridgeScene initialized"
end sub

' Update status display
sub UpdateStatus(status$ as String, color$ as String)
    if m.statusLabel <> invalid
        m.statusLabel.text = status$
        m.statusLabel.color = color$
    end if
end sub

' Update IP display
sub UpdateIP(ip$ as String)
    if m.ipLabel <> invalid
        m.ipLabel.text = "Target: " + ip$
    end if
end sub

' Handle key events
function onKeyEvent(key as String, press as Boolean) as Boolean
    if press
        if key = "back"
            ' Don't exit on back — bridge keeps running
            return true
        else if key = "options"
            ' Show debug overlay
            return true
        end if
    end if
    return false
end function
