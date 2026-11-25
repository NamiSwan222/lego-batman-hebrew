# Renders Hebrew letters as white glyphs with a dark outline (the style of the game's font).
# Output: JSON list of { code, w, h, bgra (base64) }.
# Usage: powershell -NoProfile -File render-glyphs.ps1 -Out glyphs.json -FontFile fonts\DavidLibre-Bold.ttf
#        (or -Font "<installed family>" instead of -FontFile)
param(
  [Parameter(Mandatory = $true)][string]$Out,
  [string]$Chars = "",
  [string]$FontFile = "",
  [string]$Font = "Courier New",
  [int]$CellHeight = 48,
  # The game font's baseline is 37. build.js passes the values that line the Hebrew ink up with
  # the Latin capitals (rows 9-38 of the 48px cell) for David Libre Bold: -EmSize 46 -Baseline 34.
  [int]$Baseline = 35,
  [float]$EmSize = 46,
  [float]$Outline = 6
)
Add-Type -AssemblyName System.Drawing
if (-not $Chars) { $Chars = -join (0x05D0..0x05EA | ForEach-Object { [char]$_ }) }
if ($FontFile) {
  $collection = New-Object System.Drawing.Text.PrivateFontCollection
  $collection.AddFontFile((Resolve-Path $FontFile).Path)
  $family = $collection.Families[0]
} else {
  $family = New-Object System.Drawing.FontFamily $Font
}
$style = [System.Drawing.FontStyle]::Bold
$ascent = $EmSize * $family.GetCellAscent($style) / $family.GetEmHeight($style)
$fmt = [System.Drawing.StringFormat]::GenericTypographic
$result = @()
foreach ($ch in $Chars.ToCharArray()) {
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $path.AddString([string]$ch, $family, [int]$style, $EmSize, (New-Object System.Drawing.PointF 0, ($Baseline - $ascent)), $fmt)
  $pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(255, 24, 24, 24)), $Outline
  $pen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
  $b = $path.GetBounds()
  $pad = [math]::Ceiling($Outline / 2) + 1
  $w = [int][math]::Ceiling($b.Width) + 2 * $pad
  $m = New-Object System.Drawing.Drawing2D.Matrix
  $m.Translate(($pad - $b.X), 0)
  $path.Transform($m)
  $bmp = New-Object System.Drawing.Bitmap $w, $CellHeight, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.Clear([System.Drawing.Color]::FromArgb(0, 0, 0, 0))
  $g.DrawPath($pen, $path)
  $g.FillPath([System.Drawing.Brushes]::White, $path)
  $g.Dispose()
  $rect = New-Object System.Drawing.Rectangle 0, 0, $w, $CellHeight
  $data = $bmp.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $bytes = New-Object byte[] ($w * $CellHeight * 4)
  for ($y = 0; $y -lt $CellHeight; $y++) {
    [System.Runtime.InteropServices.Marshal]::Copy([IntPtr]($data.Scan0.ToInt64() + $y * $data.Stride), $bytes, $y * $w * 4, $w * 4)
  }
  $bmp.UnlockBits($data)
  $bmp.Dispose()
  $result += [pscustomobject]@{ code = [int]$ch; w = $w; h = $CellHeight; bgra = [Convert]::ToBase64String($bytes) }
}
$json = ConvertTo-Json -InputObject $result -Depth 3 -Compress
[System.IO.File]::WriteAllText($Out, $json, (New-Object System.Text.UTF8Encoding $false))
