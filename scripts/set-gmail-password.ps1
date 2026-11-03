$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskEnvPath = Join-Path $taskRoot '.env'
if (-not (Test-Path -LiteralPath $taskEnvPath)) {
    throw '先に .env.example を .env にコピーして、送信元を設定してください。'
}
$taskEnvText = [System.IO.File]::ReadAllText($taskEnvPath)
if ($taskEnvText -notmatch '(?m)^SMTP_HOST=smtp\.gmail\.com\r?$') {
    throw 'この入力手順はGmail送信の設定専用です。'
}
$taskSecureValue = Read-Host 'Googleで発行した16文字のアプリパスワード（画面には表示しません）' -AsSecureString
$taskPointer = [IntPtr]::Zero
try {
    $taskPointer = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($taskSecureValue)
    $taskPlainValue = [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($taskPointer) -replace '\s', ''
    if ($taskPlainValue -notmatch '^[A-Za-z0-9]{16}$') {
        throw 'アプリパスワードは空白を除いて16文字です。通常のGoogleパスワードは入力しないでください。'
    }
    $taskUpdated = if ($taskEnvText -match '(?m)^SMTP_PASSWORD=') {
        [regex]::Replace($taskEnvText, '(?m)^SMTP_PASSWORD=[^\r\n]*', ('SMTP_PASSWORD=' + $taskPlainValue))
    } else {
        $taskEnvText.TrimEnd() + [Environment]::NewLine + 'SMTP_PASSWORD=' + $taskPlainValue + [Environment]::NewLine
    }
    [System.IO.File]::WriteAllText($taskEnvPath, $taskUpdated, [System.Text.UTF8Encoding]::new($false))
    Write-Host 'アプリパスワードをローカル設定へ保存しました。値は表示していません。'
    Write-Host 'このチャットへ「設定しました」と返信してください。接続確認と通常モードへの切替を進めます。'
} finally {
    if ($taskPointer -ne [IntPtr]::Zero) {
        [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($taskPointer)
    }
    $taskPlainValue = $null
    $taskUpdated = $null
    $taskSecureValue.Dispose()
}
