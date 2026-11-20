#requires -Version 7
param([string]$Makensis = '', [string]$Plugins = '')

$ErrorActionPreference = 'Stop'
$repository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$cache = if ($env:ELECTRON_BUILDER_CACHE) { $env:ELECTRON_BUILDER_CACHE } else {
    Join-Path $env:LOCALAPPDATA 'electron-builder/Cache'
}
if (!$Makensis) {
    $Makensis = Get-ChildItem -LiteralPath $cache -Filter makensis.exe -File -Recurse |
        Where-Object { Test-Path -LiteralPath (Join-Path $_.DirectoryName 'Include/MUI2.nsh') } |
        Select-Object -First 1 -ExpandProperty FullName
}
if (!$Plugins) {
    $Plugins = Get-ChildItem -LiteralPath $cache -Filter StdUtils.dll -File -Recurse |
        Where-Object { $_.Directory.Name -eq 'x86-unicode' } |
        Select-Object -First 1 -ExpandProperty DirectoryName
}
if (!$Makensis -or !$Plugins) { throw '缺少已缓存的 NSIS 工具，请先完成一次桌面打包' }

$temporary = Join-Path ([IO.Path]::GetTempPath()) ('agentdeck-installer-pages-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $temporary | Out-Null
$userDirectory = Join-Path $temporary '我的工具 user'
$machineDirectory = Join-Path $temporary 'machine tools'
foreach ($directory in @($userDirectory, $machineDirectory)) {
    New-Item -ItemType Directory -Path $directory | Out-Null
    [IO.File]::WriteAllText((Join-Path $directory 'AgentDeck.exe'), 'fixture')
}
$freshDirectory = Join-Path $temporary 'fresh'
$staleDirectory = Join-Path $temporary 'missing'
$movedDirectory = Join-Path $temporary 'moved tools'
$cases = @(
    @{ name = '首次安装'; target = $freshDirectory; mode = 'CurrentUser'; page = 'shown'; final = "$freshDirectory\AgentDeck" },
    @{ name = '首次默认目录不重复追加'; target = "$freshDirectory\AgentDeck"; mode = 'CurrentUser'; page = 'shown' },
    @{ name = '当前用户更新保留中文空格目录'; user = $userDirectory; target = $userDirectory; mode = 'CurrentUser'; page = 'skipped'; forceUser = '1' },
    @{ name = '全机更新'; machine = $machineDirectory; target = $machineDirectory; mode = 'all'; page = 'skipped'; forceMachine = '1' },
    @{ name = '双范围保留范围选择'; user = $userDirectory; machine = $machineDirectory; target = $userDirectory; mode = 'CurrentUser'; page = 'skipped' },
    @{ name = '残留登记允许选择目录'; user = $staleDirectory; target = $staleDirectory; mode = 'CurrentUser'; page = 'shown'; final = "$staleDirectory\AgentDeck" },
    @{ name = '残留用户登记不遮挡全机更新'; user = $staleDirectory; machine = $machineDirectory; target = $machineDirectory; mode = 'all'; page = 'skipped'; forceMachine = '1' },
    @{ name = '显式切换至全机'; user = $userDirectory; target = $freshDirectory; mode = 'all'; args = '/allusers'; page = 'shown'; final = "$freshDirectory\AgentDeck" },
    @{ name = '显式切换至当前用户'; machine = $machineDirectory; target = $freshDirectory; mode = 'CurrentUser'; args = '/currentuser'; page = 'shown'; final = "$freshDirectory\AgentDeck" },
    @{ name = '显式迁移目录不追加子目录'; user = $userDirectory; target = $movedDirectory; mode = 'CurrentUser'; args = "/D=$movedDirectory"; page = 'shown'; forceUser = '1' },
    @{ name = '原生更新参数继续生效'; user = $userDirectory; target = $userDirectory; mode = 'CurrentUser'; args = '--updated'; page = 'skipped'; forceUser = '1'; updated = '1' }
)

# 清理仅进入本次临时目录，不跟随链接；文件和空目录逐项删除。
function Remove-FixtureItem([string]$Path) {
    $item = Get-Item -LiteralPath $Path -Force
    if ($item.PSIsContainer -and !($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        foreach ($child in Get-ChildItem -LiteralPath $Path -Force) { Remove-FixtureItem $child.FullName }
    }
    Remove-Item -LiteralPath $Path -Force
}

$results = @()
try {
    $templates = Join-Path $repository 'node_modules/app-builder-lib/templates/nsis'
    $compile = @('/V2', '/INPUTCHARSET', 'UTF8', "/X!addincludedir `"$templates`"", "/X!addincludedir `"$templates\include`"",
        "/X!addplugindir /x86-unicode `"$Plugins`"",
        '/DAPP_GUID=agentdeck-installer-pages-fixture', '/DUNINSTALL_APP_KEY=agentdeck-installer-pages-fixture',
        "/DTEMPLATE_DIR=$templates", "/DINSTALLER_INCLUDE=$repository\apps\desktop\assets\installer.nsh",
        '/DINSTALL_MODE_PER_ALL_USERS_REQUIRED', "/DOUTPUT_FILE=$temporary\installer-pages.exe",
        (Join-Path $PSScriptRoot 'installer-pages.nsi'))
    & $Makensis @compile
    if ($LASTEXITCODE -ne 0) { throw 'NSIS 页面夹具编译失败' }
    foreach ($case in $cases) {
        $fixtureInput = "[fixture]`r`ntarget=$($case.target)`r`nmode=$($case.mode)`r`nuser=$($case.user)`r`nmachine=$($case.machine)`r`n"
        [IO.File]::WriteAllText((Join-Path $temporary 'input.ini'), $fixtureInput, [Text.Encoding]::Unicode)
        [IO.File]::WriteAllText((Join-Path $temporary 'result.ini'), '', [Text.Encoding]::Unicode)
        $start = [Diagnostics.ProcessStartInfo]::new()
        $start.FileName = Join-Path $temporary 'installer-pages.exe'
        $start.Arguments = $case.args
        $start.UseShellExecute = $false
        $start.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
        $child = [Diagnostics.Process]::Start($start)
        if (!$child.WaitForExit(15000)) { $child.Kill(); throw "夹具超时：$($case.name)" }
        if ($child.ExitCode -ne 0) { throw "夹具执行失败：$($case.name)" }
        $actual = @{}
        foreach ($line in Get-Content -LiteralPath (Join-Path $temporary 'result.ini')) {
            if ($line -match '^([^=]+)=(.*)$') { $actual[$Matches[1]] = $Matches[2] }
        }
        $expected = @{
            directory = $case.page
            target = if ($case.final) { $case.final } else { $case.target }
            forceUser = if ($case.forceUser) { $case.forceUser } else { '0' }
            forceMachine = if ($case.forceMachine) { $case.forceMachine } else { '0' }
            updated = if ($case.updated) { $case.updated } else { '0' }
        }
        foreach ($key in $expected.Keys) {
            if ($actual[$key] -cne $expected[$key]) { throw "$($case.name)：$key 不符合预期（$($actual[$key])）" }
        }
        $results += @{ name = $case.name; passed = $true }
    }
} finally {
    $verified = [IO.Path]::GetFullPath($temporary)
    if ([IO.Path]::GetDirectoryName($verified) -ne [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') -or
        ![IO.Path]::GetFileName($verified).StartsWith('agentdeck-installer-pages-')) {
        throw '夹具目录不在预定临时范围内'
    }
    Remove-FixtureItem $verified
}
$reportDirectory = Join-Path $repository 'release/verification'
New-Item -ItemType Directory -Path $reportDirectory -Force | Out-Null
$report = @{ scope = '原生 NSIS 页面钩子；安装状态为隔离夹具，未执行真实安装或系统登记'; cases = $results }
[IO.File]::WriteAllText((Join-Path $reportDirectory 'installer-pages.json'), ($report | ConvertTo-Json -Depth 4) + "`n", [Text.UTF8Encoding]::new($false))
Write-Output "NSIS 页面回归：$($results.Count) 项通过"
