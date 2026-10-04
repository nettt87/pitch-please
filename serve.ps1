$root = $PSScriptRoot
$listener = [System.Net.HttpListener]::new()
$listener.Prefixes.Add("http://127.0.0.1:5173/")
try {
  $listener.Start()
} catch {
  Write-Error "Could not listen on http://127.0.0.1:5173/ (is another server already running there?) $($_.Exception.Message)"
  exit 1
}
Write-Output "Serving $root at http://127.0.0.1:5173/"
while ($listener.IsListening) {
  $ctx = $listener.GetContext()
  $path = [Uri]::UnescapeDataString($ctx.Request.Url.LocalPath.TrimStart("/"))
  if ([string]::IsNullOrWhiteSpace($path)) { $path = "index.html" }
  $full = Join-Path $root $path
  if (-not (Test-Path $full) -or (Get-Item $full).PSIsContainer) {
    $ctx.Response.StatusCode = 404
    $ctx.Response.Close()
    continue
  }
  $ext = [IO.Path]::GetExtension($full).ToLowerInvariant()
  $ctx.Response.ContentType = switch ($ext) {
    ".html" { "text/html; charset=utf-8" }
    ".css"  { "text/css; charset=utf-8" }
    ".js"   { "text/javascript; charset=utf-8" }
    ".svg"  { "image/svg+xml" }
    ".json" { "application/json" }
    default { "application/octet-stream" }
  }
  $bytes = [IO.File]::ReadAllBytes($full)
  $ctx.Response.ContentLength64 = $bytes.Length
  $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
  $ctx.Response.Close()
}
