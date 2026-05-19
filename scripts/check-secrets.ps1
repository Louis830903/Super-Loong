# v3 Task 0a: 密钥模式正则扫描（pre-commit hook）
# 作为 detect-secrets 的补充，覆盖 AWS/OpenAI/Slack/Google/GitHub 常见密钥格式
# @issue V3-001

param(
    [string[]]$Files
)

$ErrorActionPreference = "Stop"
$exitCode = 0

# 已知密钥模式（来源: AWS/git-secrets + 各平台官方文档）
$patterns = @{
    'AWS Access Key'    = 'AKIA[0-9A-Z]{16}'
    'OpenAI API Key'    = 'sk-(proj-)?[A-Za-z0-9_-]{32,}'
    'Slack Token'       = 'xox[bpras]-[A-Za-z0-9-]+'
    'Google API Key'    = 'AIza[0-9A-Za-z\-_]{35}'
    'Google OAuth'      = 'ya29\.[0-9A-Za-z\-_]+'
    'GitHub Token'      = 'gh[pousr]_[A-Za-z0-9_]{36,}'
    'Generic High-Entropy' = '\b[A-Za-z0-9+/]{40,60}\b'
}

foreach ($file in $Files) {
    if (-not (Test-Path $file)) { continue }
    $content = Get-Content $file -Raw -ErrorAction SilentlyContinue
    if (-not $content) { continue }

    foreach ($name in $patterns.Keys) {
        $pat = $patterns[$name]
        $matches = [regex]::Matches($content, $pat)
        foreach ($m in $matches) {
            $lineNum = ($content.Substring(0, $m.Index).Split("`n")).Count
            $msg = "$file" + ":" + $lineNum + ": [" + $name + "] " + $m.Value
            Write-Host $msg
            $exitCode = 1
        }
    }
}

exit $exitCode
