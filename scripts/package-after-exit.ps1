# 退出 Deva 后自动打包
#
# 为什么需要它：Deva 的对话在 Deva 里跑，你一退出应用、对话就停了，没法再回来说一句
# 「我退出了，打包吧」。所以把这个动作交给一个独立的脚本：它自己等 Deva 退干净
# （包括托盘驻留的那几个进程），再执行 pnpm package:win，最后把结果写进日志并弹个提示。
#
# 用法：在 PowerShell 里执行
#   powershell -ExecutionPolicy Bypass -File <仓库>\scripts\package-after-exit.ps1
# 然后正常退出 Deva 即可（托盘图标右键退出，不是只关窗口）。
#
# 日志：写到脚本所在仓库根目录下的 package-after-exit.log

$ErrorActionPreference = 'Stop'
# 仓库根 = 脚本所在目录的上一级（scripts/ 的父目录）。不写死本机路径：换机器、换盘符都能用。
$repo = Split-Path -Parent $PSScriptRoot
$log = Join-Path $repo 'package-after-exit.log'

# MessageBox 在 Windows PowerShell 里要显式加载，否则调用时抛「找不到类型」。
Add-Type -AssemblyName System.Windows.Forms | Out-Null

function Write-Log([string]$msg) {
  $line = "[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $msg
  Write-Host $line
  Add-Content -Path $log -Value $line -Encoding UTF8
}

Set-Content -Path $log -Value '' -Encoding UTF8
Write-Log "等待 Deva 退出（请在托盘图标上右键退出，只关窗口不算）…"

# 等 Deva 全部进程退出：最长等 3 小时（够长，不必急着退），每 2 秒看一次。
$deadline = (Get-Date).AddHours(3)
while ((Get-Date) -lt $deadline) {
  $procs = @(Get-Process -Name 'Deva' -ErrorAction SilentlyContinue)
  if ($procs.Count -eq 0) { break }
  Start-Sleep -Seconds 2
}

$procs = @(Get-Process -Name 'Deva' -ErrorAction SilentlyContinue)
if ($procs.Count -gt 0) {
  Write-Log "等了 3 小时 Deva 仍在运行（$($procs.Count) 个进程），放弃打包。"
  [System.Windows.Forms.MessageBox]::Show(
    "Deva 一直没有退出，本次没有打包。想看日志：${log}", 'Deva 打包已中止') | Out-Null
  exit 1
}

# 再等一下：进程刚退时文件句柄可能还没完全释放。
Start-Sleep -Seconds 3
Write-Log 'Deva 已退出，开始打包。'

Push-Location $repo
try {
  # pnpm 在 PowerShell 里是 .cmd，直接掉 pnpm 会报「无法识别」，故走 cmd /c。
  # 输出同时写进日志，方便事后查看（打包要几分钟）。
  $output = & cmd /c "pnpm package:win 2>&1"
  $code = $LASTEXITCODE
  $output | ForEach-Object { Add-Content -Path $log -Value $_ -Encoding UTF8 }
} finally {
  Pop-Location
}

if ($code -eq 0) {
  $exe = Join-Path $repo 'apps\desktop\dist\win-unpacked\Deva.exe'
  Write-Log '打包成功。'
  Write-Log "从 ${exe} 启动即可。"
  [System.Windows.Forms.MessageBox]::Show(
    "打包成功，可以启动 Deva 了。`n`n路径：${exe}",
    'Deva 打包完成') | Out-Null
} else {
  Write-Log "打包失败，退出码 ${code}。完整输出见 ${log}"
  [System.Windows.Forms.MessageBox]::Show(
    "打包失败（退出码 ${code}），详情见日志：`n${log}", 'Deva 打包失败') | Out-Null
  exit $code
}
