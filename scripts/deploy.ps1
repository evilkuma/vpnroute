# Отправка vpnroute на роутер и установка (запуск с ПК под Windows).
#   .\scripts\deploy.ps1                       # роутер 192.168.2.1, пользователь root
#   .\scripts\deploy.ps1 -NoDeps               # только обновить файлы, без установки пакетов
#   .\scripts\deploy.ps1 -Router 192.168.1.1
#   .\scripts\deploy.ps1 -NoInstall            # только скопировать в /tmp/vpnroute
# Нужны ssh, scp и tar — они встроены в Windows 10/11.

param(
    [string]$Router = '192.168.2.1',
    [string]$User = 'root',
    [switch]$NoInstall,
    [switch]$NoDeps
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$archive = Join-Path $env:TEMP 'vpnroute.tar.gz'
$target = "$User@$Router"

Write-Host "[deploy] упаковка $repo"
if (Test-Path $archive) { Remove-Item $archive -Force }
tar -czf $archive -C $repo files scripts
if ($LASTEXITCODE -ne 0) { throw 'не удалось создать архив' }

Write-Host "[deploy] копирование на $target"
# -O: старый протокол scp, на OpenWrt нет sftp-сервера
scp -O $archive "${target}:/tmp/vpnroute.tar.gz"
if ($LASTEXITCODE -ne 0) { throw 'не удалось скопировать архив' }

$cmd = 'rm -rf /tmp/vpnroute && mkdir -p /tmp/vpnroute && tar -xzf /tmp/vpnroute.tar.gz -C /tmp/vpnroute && rm /tmp/vpnroute.tar.gz'
if (-not $NoInstall) {
    $flags = ''
    if ($NoDeps) { $flags = ' --no-deps' }
    $cmd += " && sh /tmp/vpnroute/scripts/install.sh$flags"
}

Write-Host "[deploy] установка"
ssh $target $cmd
if ($LASTEXITCODE -ne 0) { throw "установка завершилась с ошибкой (код $LASTEXITCODE)" }

Remove-Item $archive -Force
Write-Host '[deploy] готово'
