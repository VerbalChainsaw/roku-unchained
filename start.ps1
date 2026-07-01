# Roku Unchained — startup script with zombie cleanup
# Usage: .\start.ps1

Write-Host "Cleaning up old instances..." -ForegroundColor Gray

# Kill anything on our ports
$ports = @(4700..4710) + @(9090..9099)
$killed = 0
foreach ($port in $ports) {
    $conns = Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue
    foreach ($c in $conns) {
        Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue
        $killed++
    }
}
if ($killed -gt 0) { Write-Host "  Killed $killed zombie process(es)" -ForegroundColor Yellow }

Start-Sleep 1
Write-Host "Starting Roku Unchained..." -ForegroundColor Green
Write-Host ""

node server.js
