# Pad MiniMax H3's conditioning latents, as its main latent already is.
#
# ComfyUI pads the main video latent to the model's patch size:
#
#     video_x = comfy.ldm.common_dit.pad_to_patch_size(video_x, self.patch_size)
#
# but _cond_video_rows patchifies the start/end-frame latent without doing the
# same. patchify_video floor-divides and then reshapes, so a latent with an odd
# width — 720px / 16 = 45 — asks for a reshape to 44 and torch refuses:
#
#     shape '[1, 24, 1, 1, 40, 2, 22, 2]' is invalid for input of size 86400
#
# The run dies six seconds in, before the model does anything. Any target width
# or height not divisible by 32 hits it, but only when a guide frame is attached.
#
# This adds the missing pad. It is ComfyUI's file, so it keeps a .bak and can be
# undone with -Undo. A ComfyUI update will overwrite it; rerun this then.
#
#   powershell -ExecutionPolicy Bypass -File patch-minimax-guide.ps1
#   powershell -ExecutionPolicy Bypass -File patch-minimax-guide.ps1 -Undo

param([switch]$Undo)

$ErrorActionPreference = 'Stop'

$roots = @(
  "$env:LOCALAPPDATA\Comfy-Desktop\ComfyUI-Installs",
  "$env:LOCALAPPDATA\Programs\@comfyorgcomfyui-electron",
  'C:\ComfyUI'
)

$file = $null
foreach ($r in $roots) {
  if (-not (Test-Path $r)) { continue }
  $hit = Get-ChildItem $r -Recurse -Filter 'model.py' -ErrorAction SilentlyContinue |
         Where-Object { $_.FullName -match '\\comfy\\ldm\\minimax\\model\.py$' } |
         Select-Object -First 1
  if ($hit) { $file = $hit.FullName; break }
}

if (-not $file) {
  Write-Host "Could not find comfy\ldm\minimax\model.py." -ForegroundColor Red
  Write-Host "Edit the `$roots list at the top of this script to point at your ComfyUI folder."
  exit 1
}

Write-Host "Found: $file"
$backup = "$file.bak"

if ($Undo) {
  if (-not (Test-Path $backup)) { Write-Host "No .bak to restore." -ForegroundColor Yellow; exit 1 }
  Copy-Item $backup $file -Force
  Write-Host "Restored the original. Restart ComfyUI." -ForegroundColor Green
  exit 0
}

$text = [System.IO.File]::ReadAllText($file)

if ($text -match 'pad_to_patch_size\(z,') {
  Write-Host "Already patched. Nothing to do." -ForegroundColor Yellow
  exit 0
}

# The one line inside _cond_video_rows, matched with its own indentation so the
# replacement lands at the same depth.
$pattern = '(?m)^(\s*)r = patchify_video\(z\.to\(torch\.float32\), self\.patch_size\)'
if ($text -notmatch $pattern) {
  Write-Host "The line this patch targets is not in the file — ComfyUI has changed it." -ForegroundColor Red
  Write-Host "Nothing was modified."
  exit 1
}

$replacement = '${1}z = comfy.ldm.common_dit.pad_to_patch_size(z, self.patch_size)' + "`r`n" +
               '${1}r = patchify_video(z.to(torch.float32), self.patch_size)'

$patched = [regex]::Replace($text, $pattern, $replacement)

if (-not (Test-Path $backup)) { Copy-Item $file $backup }
[System.IO.File]::WriteAllText($file, $patched)

Write-Host ""
Write-Host "Patched. Backup at $backup" -ForegroundColor Green
Write-Host "Restart ComfyUI for it to take effect."
