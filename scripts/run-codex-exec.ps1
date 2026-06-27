param(
  [Parameter(Mandatory = $true)][string]$CodexCli,
  [Parameter(Mandatory = $true)][string]$Workspace,
  [Parameter(Mandatory = $true)][string]$OutputLastMessage,
  [Parameter(Mandatory = $true)][string]$PromptPath
)

$ErrorActionPreference = "Stop"
$promptText = Get-Content -Raw -LiteralPath $PromptPath

$promptText | & $CodexCli exec `
  --cd $Workspace `
  --sandbox workspace-write `
  --ephemeral `
  --ignore-user-config `
  --json `
  --output-last-message $OutputLastMessage `
  -

exit $LASTEXITCODE
