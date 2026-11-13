#requires -Version 5.1
<#
.SYNOPSIS
  dsh-ris-ide 的 Windows wrapper：把服务输出写进日志、写 pidfile、让面板能停能查。
  （Linux/macOS 用同目录的 run-with-log.sh，本脚本是它的零依赖等价物。）

.DESCRIPTION
  由插件宿主以
    powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File run-with-log.ps1 -SpecBase64 <b64>
  启动。`-SpecBase64` 是 UTF-8 JSON 的 base64，字段：
    { logName, logDir, kind: 'spring'|'frontend'|'command', dir,
      mainClass?, args?: string[], jvmArgs?: string[],
      packageManager?, script?, command? }

  - spring   : 依次 `mvn -Pdev compile`、`mvn -Pdev dependency:build-classpath …`，
               然后 `java -DJM.LOG.PATH=… -Dcsp.sentinel.log.dir=… <jvmArgs> -cp "target\classes;<cp>" <mainClass> <args>`；
  - frontend : `<pnpm|npm|yarn>.cmd run <script>`；
  - command  : 用户的 `startCommand`，交给 `cmd.exe /d /s /c "<命令原样>"` 执行；
               bash 方言（$()、${...}、exec）会直接启动失败并在日志里提示改用 runtime:"bash"。

  本文件必须以 UTF-8 with BOM 保存：Windows PowerShell 5.1 对没有 BOM 的文件按 ANSI
  解码，中文注释会与换行拼错行（真机已复现），导致代码行被吞掉。

  pidfile 与 .sh 一致：`<log>.pid` 一行 `<servicePid> <wrapperPid> <epochMs> [<stopGraceMs>]`。
  停止由宿主 `taskkill /PID <wrapperPid> /T /F` 完成（Windows 没有 POSIX 信号/进程组，
  /T 杀整棵进程树）；本脚本在被正常结束时（服务自己退出）删除 pidfile 并写退出横幅。
#>
param(
  [Parameter(Mandatory = $true)][string]$SpecBase64
)

$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding($false)

function Write-Log([string]$Path, [string]$Line) {
  [System.IO.File]::AppendAllText($Path, $Line + "`r`n", $utf8)
}

function Resolve-CommandPath([string[]]$Names) {
  foreach ($Name in $Names) {
    $Command = Get-Command -Name $Name -CommandType Application, ExternalScript -ErrorAction SilentlyContinue
    if ($null -ne $Command) { return $Command.Source }
  }
  return $null
}

function Quote-WinArg([string]$Value) {
  if ($Value -eq '') { return '""' }
  if ($Value -match '^[A-Za-z0-9_\./\\:=+,@%\-]+$') { return $Value }
  # 双引号包裹；内部的 " 用 \" 转义（.NET/菜系解析器通用做法）。
  return '"' + ($Value -replace '"', '\"') + '"'
}

<#
  startCommand is a command for the CURRENT runtime's shell: with runtime=powershell
  it goes to cmd.exe /d /s /c, with runtime=bash it goes to bash -lc. Bash syntax
  ($(...), ${...}, exec) is not expanded/understood by cmd; failing with a clear hint
  beats silently running a broken command line. ${JDWP_ARGS} has already been
  substituted by the host, so a remaining ${...} is a suspicious bash expansion.

  Keep these messages ASCII: Windows PowerShell 5.1 reads a BOM-less file as ANSI,
  so non-ASCII string literals would be garbled in the log.
#>
function Assert-CommandDialect([string]$Command) {
  $Hint = ' This program runs with runtime "powershell" on Windows, so the startCommand is executed by cmd.exe.'
  if ($Command -match '\$\(') {
    throw ('startCommand uses bash command substitution $(...), which cmd cannot run.' + $Hint + ' Set runtime to "bash" for this program (requires Git Bash) or rewrite it as a cmd command. command: ' + $Command)
  }
  if ($Command -match '\$\{[^}]*\}') {
    throw ('startCommand uses ${...} variable expansion, which is bash syntax.' + $Hint + ' Use %VAR% or set runtime to "bash". command: ' + $Command)
  }
  if ($Command -match '(^|\s|&&|\|\|)exec\s+') {
    throw ('startCommand uses the bash exec builtin.' + $Hint + ' Drop exec (Windows starts the process directly) or set runtime to "bash". command: ' + $Command)
  }
}

$SpecJson = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($SpecBase64))
$Spec = $SpecJson | ConvertFrom-Json

$LogName = [string]$Spec.logName
$LogDir = [string]$Spec.logDir
$Kind = [string]$Spec.kind
if ([string]::IsNullOrWhiteSpace($Kind)) { $Kind = 'command' }
$WorkDir = [string]$Spec.dir

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$LogFile = Join-Path $LogDir ($LogName + '.log')
$PidFile = $LogFile + '.pid'
$CspDir = Join-Path $LogDir 'csp'
New-Item -ItemType Directory -Force -Path $CspDir | Out-Null

Write-Log $LogFile ('--- ' + $LogName + ' started ' + (Get-Date -Format 'yyyy-MM-ddTHH:mm:sszzz') + ' ---')
Write-Log $LogFile ('--- kind: ' + $Kind + ' dir: ' + $WorkDir + ' ---')

$Exe = $null
$ArgList = @()
# kind=command sets this to a raw cmd.exe argument line instead of a quoted argv.
$RawArgs = $null

try {
  switch ($Kind) {
    'spring' {
      $Mvn = Resolve-CommandPath @('mvn.cmd', 'mvn.bat', 'mvn')
      if ($null -eq $Mvn) { throw 'mvn not found on PATH' }
      Push-Location -LiteralPath $WorkDir
      try {
        Write-Log $LogFile '--- mvn -Pdev compile ---'
        & $Mvn -Pdev -q compile 2>&1 | ForEach-Object { Write-Log $LogFile ([string]$_) }
        if ($LASTEXITCODE -ne 0) { throw ('mvn compile failed (exit ' + $LASTEXITCODE + ')') }
        Write-Log $LogFile '--- mvn dependency:build-classpath ---'
        & $Mvn -Pdev -q dependency:build-classpath '-Dmdep.includeScope=runtime' '-Dmdep.outputFile=target/cp.txt' 2>&1 | ForEach-Object { Write-Log $LogFile ([string]$_) }
        if ($LASTEXITCODE -ne 0) { throw ('mvn build-classpath failed (exit ' + $LASTEXITCODE + ')') }
      } finally {
        Pop-Location
      }
      $CpFile = Join-Path $WorkDir 'target\cp.txt'
      if (-not (Test-Path -LiteralPath $CpFile)) { throw ('classpath file not found: ' + $CpFile) }
      $ClassPath = 'target\classes;' + ((Get-Content -LiteralPath $CpFile -Raw).Trim())
      $Exe = Resolve-CommandPath @('java.exe', 'java')
      if ($null -eq $Exe) { throw 'java not found on PATH' }
      $ArgList = @('-DJM.LOG.PATH=' + $LogDir, '-Dcsp.sentinel.log.dir=' + $CspDir)
      foreach ($Item in @($Spec.jvmArgs)) { if (-not [string]::IsNullOrWhiteSpace([string]$Item)) { $ArgList += [string]$Item } }
      $ArgList += @('-cp', $ClassPath)
      $ArgList += [string]$Spec.mainClass
      foreach ($Item in @($Spec.args)) { if (-not [string]::IsNullOrWhiteSpace([string]$Item)) { $ArgList += [string]$Item } }
    }
    'frontend' {
      $Pm = [string]$Spec.packageManager
      if ([string]::IsNullOrWhiteSpace($Pm)) { $Pm = 'npm' }
      $Exe = Resolve-CommandPath @(($Pm + '.cmd'), ($Pm + '.bat'), $Pm)
      if ($null -eq $Exe) { throw ($Pm + ' not found on PATH') }
      $Script = [string]$Spec.script
      if ([string]::IsNullOrWhiteSpace($Script)) { $Script = 'dev' }
      $ArgList = @('run', $Script)
    }
    default {
      $Command = [string]$Spec.command
      if ([string]::IsNullOrWhiteSpace($Command)) { throw 'startCommand is empty (nothing to run)' }
      Assert-CommandDialect $Command
      $Exe = Resolve-CommandPath @('cmd.exe')
      if ($null -eq $Exe) { throw 'cmd.exe not found' }
      # 命令交给 cmd.exe /d /s /c；`/s` 至多剥掉首尾各一个引号，所以整条命令包一层
      # 引号、内部引号原样保留才是 cmd 的语义。旧的 argv+Quote-WinArg 组装会把内部
      # " 变成 cmd 不认识的 \"（cmd 不是 .NET 参数解析器）。
      $RawArgs = '/d /s /c "' + $Command + '"'
    }
  }
} catch {
  Write-Log $LogFile ('--- ' + $LogName + ' failed to start: ' + $_.Exception.Message + ' ---')
  exit 1
}

# kind=command 用 cmd.exe 的原始参数行（见上）；其余 kind 都是结构化 argv，逐项引用。
$ExecArgs = if ($null -ne $RawArgs) { $RawArgs } else { (($ArgList | ForEach-Object { Quote-WinArg ([string]$_) }) -join ' ') }

Write-Log $LogFile ('--- exec: ' + $Exe + ' ' + $ExecArgs + ' ---')

$StartInfo = New-Object System.Diagnostics.ProcessStartInfo
$StartInfo.FileName = $Exe
$StartInfo.WorkingDirectory = $WorkDir
$StartInfo.UseShellExecute = $false
$StartInfo.RedirectStandardOutput = $true
$StartInfo.RedirectStandardError = $true
$StartInfo.CreateNoWindow = $true
$StartInfo.Arguments = $ExecArgs

$Process = New-Object System.Diagnostics.Process
$Process.StartInfo = $StartInfo
if (-not $Process.Start()) { throw ('failed to start ' + $Exe) }

# pidfile: <servicePid> <wrapperPid> <epochMs> [<stopGraceMs>]
$GraceMs = 0
if (-not [string]::IsNullOrWhiteSpace($env:DSH_STOP_GRACE_MS)) {
  $Parsed = 0
  if ([int]::TryParse($env:DSH_STOP_GRACE_MS, [ref]$Parsed)) { $GraceMs = $Parsed }
}
$EpochMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
Set-Content -LiteralPath $PidFile -Value ($Process.Id.ToString() + ' ' + $PID.ToString() + ' ' + $EpochMs.ToString() + ' ' + $GraceMs.ToString()) -Encoding Ascii

# 输出实时进日志（BeginOutputReadLine + 事件处理器，避免缓冲区互锁）。
$Stream = New-Object System.IO.FileStream($LogFile, [System.IO.FileMode]::Append, [System.IO.FileAccess]::Write, [System.IO.FileShare]::ReadWrite)
$Writer = New-Object System.IO.StreamWriter($Stream, $utf8)
$Writer.AutoFlush = $true
$State = [hashtable]::Synchronized(@{ Writer = $Writer })
$StdoutEvent = Register-ObjectEvent -InputObject $Process -EventName OutputDataReceived -MessageData $State -Action {
  $Line = $Event.SourceEventArgs.Data
  if ($null -ne $Line) { $Event.MessageData.Writer.WriteLine($Line) }
}
$StderrEvent = Register-ObjectEvent -InputObject $Process -EventName ErrorDataReceived -MessageData $State -Action {
  $Line = $Event.SourceEventArgs.Data
  if ($null -ne $Line) { $Event.MessageData.Writer.WriteLine($Line) }
}

$Status = 1
try {
  $Process.BeginOutputReadLine()
  $Process.BeginErrorReadLine()
  $Process.WaitForExit()
  $Status = $Process.ExitCode
} finally {
  foreach ($Event in @($StdoutEvent, $StderrEvent)) {
    if ($null -ne $Event) { Unregister-Event -SourceIdentifier $Event.Name -ErrorAction SilentlyContinue }
  }
  $Writer.Flush()
  $Writer.Dispose()
  $Stream.Dispose()
  Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
}

Write-Log $LogFile ('--- ' + $LogName + ' exited ' + (Get-Date -Format 'yyyy-MM-ddTHH:mm:sszzz') + ' (status ' + $Status + ') ---')
exit $Status
