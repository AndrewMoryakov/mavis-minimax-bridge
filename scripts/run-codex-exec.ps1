param(
  [Parameter(Mandatory = $true)][string]$CodexCli,
  [Parameter(Mandatory = $true)][string]$Workspace,
  [Parameter(Mandatory = $true)][string]$Sandbox,
  [Parameter(Mandatory = $true)][string]$OutputLastMessage,
  [Parameter(Mandatory = $true)][string]$PromptPath,
  [switch]$SkipGitRepoCheck
)

$ErrorActionPreference = "Stop"
$promptText = Get-Content -Raw -LiteralPath $PromptPath

$codexArgs = @(
  "exec",
  "--cd", $Workspace,
  "--sandbox", $Sandbox,
  "--ephemeral",
  "--ignore-user-config",
  "--ignore-rules"
)

if ($SkipGitRepoCheck) {
  $codexArgs += "--skip-git-repo-check"
}

$codexArgs += @(
  "--json",
  "--output-last-message", $OutputLastMessage,
  "-"
)

$promptText | & $CodexCli @codexArgs

exit $LASTEXITCODE
