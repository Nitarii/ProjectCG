# Publier ProjectCG dans le dépôt GitHub Nitarii/ProjectCG.
# Prérequis : Git installé, et un compte autorisé à pousser sur le dépôt.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$work = Join-Path $env:TEMP ('ProjectCG_publish_' + [guid]::NewGuid().ToString('N'))
try {
  git --version | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Git doit être installé.' }
  Write-Host 'Clonage du dépôt Nitarii/ProjectCG...'
  git clone https://github.com/Nitarii/ProjectCG.git $work
  if ($LASTEXITCODE -ne 0) { throw 'Clonage impossible. Vérifier Git et les accès au dépôt.' }
  Get-ChildItem -LiteralPath $root -Recurse -File -Force | ForEach-Object {
    $relative = $_.FullName.Substring($root.Length).TrimStart('\','/')
    if ($relative -match '^data[\/](profiles\.json|profiles\.json\.tmp|profiles\.corrupt-|.+\.bak)' -or
        $relative -match '(^|[\/])(?:\.git|node_modules)(?:[\/]|$)' -or
        $_.Name -match '^cloudflared\.exe$') { return }
    $dest = Join-Path $work $relative
    $parent = Split-Path -Parent $dest
    New-Item -ItemType Directory -Force -Path $parent | Out-Null
    Copy-Item -LiteralPath $_.FullName -Destination $dest -Force
  }
  Push-Location $work
  try {
    git add --all
    git diff --cached --quiet
    if ($LASTEXITCODE -eq 0) {
      Write-Host 'Le dépôt est déjà à jour.'
    } else {
      git commit -m 'Publish ProjectCG Point Control v2.6 for GitHub Pages'
      if ($LASTEXITCODE -ne 0) { throw 'Commit impossible. Vérifier votre configuration Git.' }
      git push origin main
      if ($LASTEXITCODE -ne 0) { throw 'Publication impossible. Authentification GitHub nécessaire.' }
      Write-Host 'Fichiers du jeu publiés sur GitHub.'
    }
  } finally { Pop-Location }
  Write-Host 'Dernière étape : Settings > Pages > Source: GitHub Actions.'
  Write-Host 'Site : https://nitarii.github.io/ProjectCG/'
} finally {
  if (Test-Path $work) { Remove-Item -LiteralPath $work -Recurse -Force }
}
