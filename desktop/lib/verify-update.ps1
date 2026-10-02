param([Parameter(Mandatory=$true)][string]$InstallerPath)
$ErrorActionPreference = 'Stop'
$signature = Get-AuthenticodeSignature -LiteralPath $InstallerPath
@{ valid = ($signature.Status -eq 'Valid'); subject = $signature.SignerCertificate.Subject; path = $signature.Path } | ConvertTo-Json -Compress
