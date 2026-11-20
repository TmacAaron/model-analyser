$ErrorActionPreference = 'Stop'
# Optional online refresh. Offline references/tests only read the pinned local files.
# Verify against the committed lock before replacing any source; never fetch tensor payloads.
$taskLock = Get-Content -LiteralPath 'references/models/expansion-source-lock.json' -Raw | ConvertFrom-Json
function Read-BoundedSource([string]$Uri,[int]$Limit,[string]$Range='') {
  $taskClient=[System.Net.Http.HttpClient]::new()
  $taskClient.Timeout=[TimeSpan]::FromSeconds(30)
  $taskRequest=[System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::Get,$Uri)
  $taskRequest.Headers.TryAddWithoutValidation('Accept-Encoding','identity') | Out-Null
  if ($Range) { $taskRequest.Headers.TryAddWithoutValidation('Range',$Range) | Out-Null }
  $taskResponse=$null; $taskStream=$null; $taskBuffer=[System.IO.MemoryStream]::new()
  try {
    $taskResponse=$taskClient.SendAsync($taskRequest,[System.Net.Http.HttpCompletionOption]::ResponseHeadersRead).GetAwaiter().GetResult()
    $taskResponse.EnsureSuccessStatusCode() | Out-Null
    if ($Range -and [int]$taskResponse.StatusCode -ne 206) { throw 'Server ignored Range; tensor payload forbidden' }
    if ($null -ne $taskResponse.Content.Headers.ContentLength -and $taskResponse.Content.Headers.ContentLength -gt $Limit) { throw 'Source exceeds pinned byte budget' }
    $taskStream=$taskResponse.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
    $taskChunk=[byte[]]::new([Math]::Min(8192,$Limit+1))
    while (($taskRead=$taskStream.Read($taskChunk,0,[Math]::Min($taskChunk.Length,$Limit+1-[int]$taskBuffer.Length))) -gt 0) {
      $taskBuffer.Write($taskChunk,0,$taskRead)
      if ($taskBuffer.Length -gt $Limit) { throw 'Source exceeded pinned byte budget' }
    }
    return @{bytes=$taskBuffer.ToArray();contentRange=[string]$taskResponse.Content.Headers.ContentRange}
  } finally {
    if ($taskStream) { $taskStream.Dispose() }
    if ($taskResponse) { $taskResponse.Dispose() }
    $taskBuffer.Dispose(); $taskRequest.Dispose(); $taskClient.Dispose()
  }
}
$taskRepo=(Get-Location).Path
foreach ($taskRecord in $taskLock.records) {
  $taskTarget=[System.IO.Path]::GetFullPath((Join-Path $taskRepo $taskRecord.path))
  $taskSourceRoot=[System.IO.Path]::GetFullPath((Join-Path $taskRepo 'references/models'))+[System.IO.Path]::DirectorySeparatorChar
  if (-not $taskTarget.StartsWith($taskSourceRoot,[StringComparison]::OrdinalIgnoreCase)) { throw 'Source target escaped references/models' }
  $taskUri=[Uri]$taskRecord.url
  if ($taskUri.Scheme -ne 'https' -or $taskUri.Host -notin @('huggingface.co','raw.githubusercontent.com')) { throw 'Unexpected source host' }
  if ($taskRecord.path -eq 'references/models/glm-4-9b/first-shard-header.json') {
    if ($taskUri.Fragment -ne '#metadata-only-range-8-2015') { throw 'Unexpected metadata range' }
    $taskWeightUri=$taskUri.GetLeftPart([UriPartial]::Path)
    $taskPrefix=Read-BoundedSource $taskWeightUri 8 'bytes=0-7'
    if ($taskPrefix.bytes.Length -ne 8 -or $taskPrefix.contentRange -notlike 'bytes 0-7/*' -or [BitConverter]::ToUInt64($taskPrefix.bytes,0) -ne 2008) { throw 'Unexpected safetensors header length/range' }
    $taskData=Read-BoundedSource $taskWeightUri 2008 'bytes=8-2015'
    if ($taskData.contentRange -notlike 'bytes 8-2015/*') { throw 'Unexpected metadata Content-Range' }
  } else {
    if ($taskUri.AbsolutePath.EndsWith('.safetensors')) { throw 'Weight payload forbidden' }
    $taskData=Read-BoundedSource $taskRecord.url ([int]$taskRecord.bytes)
  }
  $taskSha=[Convert]::ToHexString([System.Security.Cryptography.SHA256]::HashData($taskData.bytes)).ToLowerInvariant()
  if ($taskData.bytes.Length -ne $taskRecord.bytes -or $taskSha -ne $taskRecord.sha256) { throw ('Pinned source hash/length differs: '+$taskRecord.path) }
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $taskTarget) | Out-Null
  [System.IO.File]::WriteAllBytes($taskTarget,$taskData.bytes)
}
Write-Output ('Verified/refreshed '+$taskLock.records.Count+' pinned metadata/source files; no tensor weight payload.')
