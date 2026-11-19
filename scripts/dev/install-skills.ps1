# 安装本项目开发用的 Agent skill（只装到当前项目，不装到全局）
#
# 用法（在仓库根目录执行）：
#   powershell -ExecutionPolicy Bypass -File scripts\dev\install-skills.ps1
#
# 说明：
# - 使用 vercel-labs/skills（npx skills）统一管理，版本固定为 $SkillsCliVersion。
# - 真实文件放在 .agents/skills/（Codex 读取），.claude/skills/ 下为指向它的目录链接（Claude Code 读取）。
# - skill 文件与 skills-lock.json 均不提交到仓库，已在 .gitignore 中忽略。
# - 默认关闭 npx skills 的匿名统计。
# - 本文件需保存为带 BOM 的 UTF-8，否则 Windows PowerShell 5.1 会把中文读成乱码。

$ErrorActionPreference = 'Stop'
$SkillsCliVersion = '1.7.0'
$env:DISABLE_TELEMETRY = '1'

# 调用 npx.cmd，避开 npx.ps1 包装脚本对数组参数的错误展开
$Npx = 'npx.cmd'

# 安装目标：Claude Code 与 Codex
$Agents = @('-a', 'claude-code', '-a', 'codex')

# 工程与协作技能与上游正式插件清单一致，不引入试验目录。
$MattRepository = 'mattpocock/skills'
$MattCommit = '5863806dd4e15c63174bee4e7515a4256792ecfa'
$MattSource = "https://github.com/$MattRepository/tree/$MattCommit/skills"
$MattSources = @(
    @{
        Source = "$MattSource/engineering"
        Skills = @(
            'ask-matt', 'code-review', 'codebase-design', 'diagnosing-bugs', 'domain-modeling',
            'grill-with-docs', 'implement', 'implement-spec', 'improve-codebase-architecture', 'pr',
            'prototype', 'research', 'retro', 'setup-matt-pocock-skills', 'tdd', 'to-spec',
            'to-tickets', 'triage', 'wayfinder', 'wizard'
        )
    },
    @{
        Source = "$MattSource/productivity"
        Skills = @('grill-me', 'grilling', 'handoff', 'teach', 'to-questionnaire', 'wait-what', 'writing-for-agents')
    }
)
$MattSkillNames = @($MattSources | ForEach-Object { $_.Skills })
$AuxiliarySources = @(
    @{ Source = 'vercel-labs/agent-skills'; Skills = @('vercel-react-best-practices') },
    @{ Source = 'anthropics/skills'; Skills = @('webapp-testing') },
    @{ Source = 'https://github.com/anthropics/claude-plugins-official/tree/main/plugins/mcp-server-dev/skills/build-mcp-server'; Skills = @() },
    @{ Source = 'nextlevelbuilder/ui-ux-pro-max-skill'; Skills = @('ui-ux-pro-max') }
)

$RepoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../..')).ProviderPath
$RepoPrefix = $RepoRoot.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
$SkillDirectories = @('.claude/skills', '.agents/skills')
$LockPath = Join-Path $RepoRoot 'skills-lock.json'

function Get-ProjectPath([string]$RelativePath) {
    $path = [IO.Path]::GetFullPath((Join-Path $RepoRoot $RelativePath))
    if (!$path.StartsWith($RepoPrefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "路径不在当前项目内：$RelativePath"
    }
    return $path
}

function Assert-NotLink([string]$RelativePath) {
    $item = Get-Item -LiteralPath (Get-ProjectPath $RelativePath) -Force -ErrorAction SilentlyContinue
    if ($item -and ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw "必须使用本项目自己的文件或目录：$RelativePath"
    }
}

function Read-SkillLock {
    if (!(Test-Path -LiteralPath $LockPath)) { return $null }
    $lock = Get-Content -LiteralPath $LockPath -Encoding UTF8 -Raw | ConvertFrom-Json
    if ($lock.version -ne 1 -or $lock.skills -isnot [pscustomobject]) {
        throw '无法识别项目 skills-lock.json 的结构。'
    }
    return $lock
}

function Install-Sources([hashtable[]]$Sources) {
    foreach ($item in $Sources) {
        $cliArgs = @('-y', "skills@$SkillsCliVersion", 'add', $item.Source)
        foreach ($name in $item.Skills) { $cliArgs += @('-s', $name) }
        $cliArgs += $Agents + @('-y')

        Write-Host "==> 安装 $($item.Source)"
        & $Npx @cliArgs
        if ($LASTEXITCODE -ne 0) { throw "安装失败：$($item.Source)（退出码 $LASTEXITCODE）" }
    }
}

function Move-RetiredSkills([pscustomobject]$Lock) {
    $names = @($Lock.skills.PSObject.Properties | Where-Object { $_.Value.source -eq 'obra/superpowers' } | ForEach-Object Name)
    if ($names.Count -eq 0) { return }
    Assert-NotLink '.scratch'
    $backup = '.scratch/.retired-superpowers-' + [guid]::NewGuid().ToString('N')
    [IO.Directory]::CreateDirectory((Get-ProjectPath $backup)) | Out-Null
    Copy-Item -LiteralPath $LockPath -Destination (Get-ProjectPath "$backup/skills-lock.json")

    foreach ($name in $names) {
        if ($name -cnotmatch '^[a-z][a-z0-9-]*$') { throw "无法迁移旧技能条目：$name" }
        $canonical = Get-ProjectPath ".agents/skills/$name"
        Assert-NotLink ".agents/skills/$name"
        # 先移走 Claude Code 的目录链接，再移动它指向的技能目录；保留旧文件以便复查。
        foreach ($directory in $SkillDirectories) {
            $source = Get-ProjectPath "$directory/$name"
            $item = Get-Item -LiteralPath $source -Force -ErrorAction SilentlyContinue
            if (!$item) { continue }
            if (!$item.PSIsContainer -or (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -and $item.Target -ne $canonical)) {
                throw "旧技能不是本项目的目录或目录链接：$directory/$name"
            }
            [IO.Directory]::CreateDirectory((Get-ProjectPath "$backup/$directory")) | Out-Null
            Move-Item -LiteralPath $source -Destination (Get-ProjectPath "$backup/$directory/$name")
        }
        $Lock.skills.PSObject.Properties.Remove($name)
    }
    [IO.File]::WriteAllText($LockPath, ($Lock | ConvertTo-Json -Depth 12) + "`n", [Text.UTF8Encoding]::new($false))
    Write-Host "==> 已归档旧技能：$backup"
}

Push-Location -LiteralPath $RepoRoot
try {
    foreach ($path in (@('.agents', '.claude', 'skills-lock.json') + $SkillDirectories)) { Assert-NotLink $path }
    $previousLock = Read-SkillLock
    foreach ($name in $MattSkillNames) {
        Assert-NotLink ".agents/skills/$name"
        $entry = if ($previousLock) { $previousLock.skills.PSObject.Properties[$name] }
        $exists = $SkillDirectories | Where-Object { Test-Path -LiteralPath (Get-ProjectPath "$_/$name") }
        if (($entry -and $entry.Value.source -ne $MattRepository) -or (!$entry -and $exists)) {
            throw "已存在同名项目技能，未覆盖：$name"
        }
    }

    Install-Sources $MattSources
    $lock = Read-SkillLock
    if (!$lock) { throw '安装未生成项目技能锁文件。' }
    foreach ($name in $MattSkillNames) {
        $entry = $lock.skills.PSObject.Properties[$name]
        $missing = $SkillDirectories | Where-Object { !(Test-Path -LiteralPath (Get-ProjectPath "$_/$name/SKILL.md") -PathType Leaf) }
        if (!$entry -or $entry.Value.source -ne $MattRepository -or $entry.Value.ref -ne $MattCommit -or $missing) {
            throw "新技能未在两个开发入口完成安装：$name"
        }
    }
    Move-RetiredSkills $lock
    Install-Sources $AuxiliarySources

    Write-Host "==> 已安装的项目级 skill"
    & $Npx -y "skills@$SkillsCliVersion" ls @Agents
    if ($LASTEXITCODE -ne 0) { throw '读取项目技能列表失败。' }
}
finally {
    Pop-Location
}
