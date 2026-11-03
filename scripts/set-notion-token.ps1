$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskEnvPath = Join-Path $taskRoot '.env'
if (-not (Test-Path -LiteralPath $taskEnvPath)) {
    throw '先に .env.example を .env にコピーしてください。'
}
$taskEnvText = [System.IO.File]::ReadAllText($taskEnvPath)
$taskSecureValue = Read-Host 'Notion内部接続のAPIトークン（画面には表示しません）' -AsSecureString
$taskPointer = [IntPtr]::Zero
try {
    $taskPointer = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($taskSecureValue)
    $taskPlainValue = [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($taskPointer).Trim()
    if ($taskPlainValue -notmatch '^(ntn_|secret_)[A-Za-z0-9_-]{20,}$') {
        throw 'NotionのAPIトークンを確認してください。ページURLや接続名ではありません。'
    }
    $taskUpdated = if ($taskEnvText -match '(?m)^NOTION_TOKEN=') {
        [regex]::Replace($taskEnvText, '(?m)^NOTION_TOKEN=[^\r\n]*', ('NOTION_TOKEN=' + $taskPlainValue))
    } else {
        $taskEnvText.TrimEnd() + [Environment]::NewLine + 'NOTION_TOKEN=' + $taskPlainValue + [Environment]::NewLine
    }
    [System.IO.File]::WriteAllText($taskEnvPath, $taskUpdated, [System.Text.UTF8Encoding]::new($false))
    Write-Host 'Notionトークンをローカル設定へ保存しました。値は表示していません。'
    Write-Host '対象ページに接続を追加したら、このチャットへ「設定しました」と返信してください。'
} finally {
    if ($taskPointer -ne [IntPtr]::Zero) {
        [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($taskPointer)
    }
    $taskPlainValue = $null
    $taskUpdated = $null
    $taskSecureValue.Dispose()
}
