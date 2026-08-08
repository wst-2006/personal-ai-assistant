$ErrorActionPreference = "Stop"
$nodePath = $env:PERSONAL_AI_RUNTIME_NODE
if ([string]::IsNullOrWhiteSpace($nodePath)) {
  exit 1
}
$expectedPath = [System.IO.Path]::GetFullPath($nodePath)

function Get-BundledNodeProcesses {
  @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object {
    if ([string]::IsNullOrWhiteSpace($_.ExecutablePath)) {
      return $false
    }

    $candidatePath = [System.IO.Path]::GetFullPath($_.ExecutablePath)
    return $candidatePath.Equals($expectedPath, [System.StringComparison]::OrdinalIgnoreCase)
  })
}

foreach ($process in Get-BundledNodeProcesses) {
  Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
}

Start-Sleep -Milliseconds 500
if ((Get-BundledNodeProcesses).Count -gt 0) {
  exit 1
}

exit 0
