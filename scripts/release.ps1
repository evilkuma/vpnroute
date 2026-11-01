# Выпуск версии vpnroute: тег vX.Y.Z и отправка на GitHub.
# Перед запуском: поднять версию в files/usr/share/vpnroute/VERSION,
# добавить раздел «## X.Y.Z — дата» в CHANGELOG.md и закоммитить.
#   .\scripts\release.ps1            # проверить и спросить подтверждение
#   .\scripts\release.ps1 -Yes       # без подтверждения
# Роутеры увидят новую версию при следующей проверке (раз в сутки или кнопкой).

param([switch]$Yes)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo

function Fail($msg) { Write-Host "[release] ОШИБКА: $msg" -ForegroundColor Red; exit 1 }

$ver = (Get-Content -Raw 'files/usr/share/vpnroute/VERSION').Trim()
if ($ver -notmatch '^\d+\.\d+\.\d+$') { Fail "некорректная версия «$ver» в VERSION" }
$tag = "v$ver"

if ((git rev-parse --abbrev-ref HEAD) -ne 'main') { Fail 'релиз выпускается из ветки main' }
if (git status --porcelain) { Fail 'есть незакоммиченные изменения' }
if (git tag --list $tag) { Fail "тег $tag уже существует: поднимите версию" }
if (-not (Select-String -Path 'CHANGELOG.md' -Pattern "^## +v?$([regex]::Escape($ver))\b" -Quiet)) {
    Fail "в CHANGELOG.md нет раздела «## $ver»"
}

git fetch -q origin main
if ($LASTEXITCODE -ne 0) { Fail 'не удалось получить origin/main' }
if (git rev-list HEAD..origin/main) { Fail 'на GitHub есть коммиты, которых нет локально: сначала git pull' }

Write-Host "[release] версия $ver, коммит $(git log -1 --format='%h %s')"
if (-not $Yes) {
    $a = Read-Host "Создать тег $tag и отправить main и тег на GitHub? (y/n)"
    if ($a -ne 'y') { Write-Host '[release] отменено'; exit 0 }
}

git tag -a $tag -m "vpnroute $ver"
if ($LASTEXITCODE -ne 0) { Fail 'не удалось создать тег' }
# атомарно: роутер берёт номер версии из main, а код по тегу, поэтому
# версия в main не должна появиться без тега
git push --atomic origin main $tag
if ($LASTEXITCODE -ne 0) {
    git tag -d $tag | Out-Null
    Fail 'не удалось отправить на GitHub, тег удалён локально'
}
Write-Host "[release] готово: $tag опубликован"
