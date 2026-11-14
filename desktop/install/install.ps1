# __NAME__ __VERSION__: installera eller uppdatera med ett kommando i PowerShell.
#   irm __BASE__/install.ps1 | iex
# Skapas av desktop/publish.mjs vid varje version, med adress och SHA-256
# inskrivna. Invoke-WebRequest märker inte filen som nedladdad från internet,
# så SmartScreen frågar inte. Stämmer inte kontrollsumman installeras inget.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$Name = '__NAME__'
$Url = '__WIN_URL__'
$Sha = '__WIN_SHA__'

$Setup = Join-Path ([IO.Path]::GetTempPath()) ("booqy-setup-" + [guid]::NewGuid() + ".exe")
try {
  Write-Host "Laddar ner $Name __VERSION__..."
  Invoke-WebRequest -Uri $Url -OutFile $Setup -UseBasicParsing
  if ((Get-FileHash -Algorithm SHA256 -Path $Setup).Hash.ToLower() -ne $Sha) {
    throw 'Kontrollsumman stämmer inte. Inget installerades.'
  }
  # En öppen äldre version stängs, annars kan installationen inte byta filerna.
  Get-Process -Name $Name -ErrorAction SilentlyContinue | Stop-Process -Force
  Write-Host 'Installerar (för den här användaren, utan administratörsrättigheter)...'
  Start-Process -FilePath $Setup -ArgumentList '/S' -Wait
} finally {
  Remove-Item -LiteralPath $Setup -Force -ErrorAction SilentlyContinue
}
$Exe = Get-ChildItem -Path (Join-Path $env:LOCALAPPDATA 'Programs') -Filter "$Name.exe" -Recurse -Depth 2 -ErrorAction SilentlyContinue | Select-Object -First 1
if ($Exe) { Start-Process -FilePath $Exe.FullName; Write-Host "Klart: $($Exe.FullName)" } else { Write-Host "Klart. Starta $Name från Start-menyn." }
