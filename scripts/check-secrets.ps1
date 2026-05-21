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
            # Generic High-Entropy 后置过滤：排除文件路径、JSDoc 注释中的合法长字符串
            if ($name -eq 'Generic High-Entropy') {
                $val = $m.Value
                # 跳过：匹配值前后紧邻路径分隔符（/、\、.）的大概率是文件路径
                $before = if ($m.Index -gt 0) { $content[$m.Index - 1] } else { '' }
                $after  = if ($m.Index + $m.Length -lt $content.Length) { $content[$m.Index + $m.Length] } else { '' }
                if ($before -match '[/\\.]' -or $after -match '[/\\.]') { continue }
                # 跳过：匹配值本身包含 / 或 \（路径特征）
                if ($val -match '[/\\]') { continue }
                # 跳过：所在行是 JSDoc 注释（以 * 或 // 开头）
                $lineStart = $content.LastIndexOf("`n", [Math]::Max(0, $m.Index - 1)) + 1
                $lineText = $content.Substring($lineStart, $m.Index - $lineStart)
                if ($lineText -match '^\s*(\*|//)') { continue }
            }
            $lineNum = ($content.Substring(0, $m.Index).Split("`n")).Count
            $msg = "$file" + ":" + $lineNum + ": [" + $name + "] " + $m.Value
            Write-Host $msg
            $exitCode = 1
        }
    }
}

exit $exitCode
