$ErrorActionPreference = 'Stop'
$taskPins = @{ qwen='c1899de289a04d12100db370d81485cdf75e47ca'; deepseek='604d5664dddd88a0433dbae533b7fe9472482de0'; transformers='0720e206c6ba28887e4d60ef60a6a089f6c1cc76' }
$taskRecords = [System.Collections.Generic.List[object]]::new()
function Read-PinnedSource([string]$Uri,[int]$Limit,[string]$Range='') {
  # Inspect headers before opening a body: a server ignoring Range must never
  # cause the weight payload to be downloaded. Every read is bounded as well.
  $taskClient = [System.Net.Http.HttpClient]::new()
  $taskClient.Timeout = [TimeSpan]::FromSeconds(30)
  $taskRequest = [System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::Get,$Uri)
  $taskRequest.Headers.TryAddWithoutValidation('Accept-Encoding','identity') | Out-Null
  if ($Range) { $taskRequest.Headers.TryAddWithoutValidation('Range',$Range) | Out-Null }
  $taskResponse=$null; $taskStream=$null; $taskBuffer=[System.IO.MemoryStream]::new()
  try {
    $taskResponse=$taskClient.SendAsync($taskRequest,[System.Net.Http.HttpCompletionOption]::ResponseHeadersRead).GetAwaiter().GetResult()
    $taskResponse.EnsureSuccessStatusCode() | Out-Null
    if ($Range -and [int]$taskResponse.StatusCode -ne 206) { throw 'Server ignored metadata Range; tensor payload is forbidden' }
    if ($null -ne $taskResponse.Content.Headers.ContentLength -and $taskResponse.Content.Headers.ContentLength -gt $Limit) { throw 'Source exceeds byte budget' }
    $taskStream=$taskResponse.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
    $taskChunk=[byte[]]::new([Math]::Min(8192,$Limit+1))
    while (($taskRead=$taskStream.Read($taskChunk,0,[Math]::Min($taskChunk.Length,$Limit+1-[int]$taskBuffer.Length))) -gt 0) {
      $taskBuffer.Write($taskChunk,0,$taskRead)
      if ($taskBuffer.Length -gt $Limit) { throw 'Source exceeded byte budget' }
    }
    return @{ bytes=$taskBuffer.ToArray(); contentRange=[string]$taskResponse.Content.Headers.ContentRange }
  } finally {
    if ($taskStream) { $taskStream.Dispose() }
    if ($taskResponse) { $taskResponse.Dispose() }
    $taskBuffer.Dispose(); $taskRequest.Dispose(); $taskClient.Dispose()
  }
}
function Save-PinnedSource([string]$Path,[string]$Uri,[byte[]]$Bytes) {
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Path) | Out-Null
  [System.IO.File]::WriteAllBytes((Join-Path (Get-Location) $Path),$Bytes)
  $taskRecords.Add(@{path=$Path;url=$Uri;bytes=$Bytes.Length;sha256=(Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()})
}
$taskQ='https://huggingface.co/Qwen/Qwen3-0.6B/resolve/'+$taskPins.qwen+'/'
$taskD='https://huggingface.co/deepseek-ai/DeepSeek-V2-Lite/resolve/'+$taskPins.deepseek+'/'
$taskT='https://raw.githubusercontent.com/huggingface/transformers/'+$taskPins.transformers+'/'
$taskFiles=@(
  @('references/models/qwen3-0.6b/config.json',($taskQ+'config.json'),16384),
  @('references/models/qwen3-0.6b/modeling_qwen3.py',($taskT+'src/transformers/models/qwen3/modeling_qwen3.py'),200000),
  @('references/models/qwen3-0.6b/LICENSE',($taskQ+'LICENSE'),50000),
  @('references/models/deepseek-v2-lite/config.json',($taskD+'config.json'),16384),
  @('references/models/deepseek-v2-lite/modeling_deepseek.py',($taskD+'modeling_deepseek.py'),200000),
  @('references/models/deepseek-v2-lite/model.safetensors.index.json',($taskD+'model.safetensors.index.json'),2000000)
)
foreach($taskFile in $taskFiles) { $taskData=Read-PinnedSource $taskFile[1] $taskFile[2]; Save-PinnedSource $taskFile[0] $taskFile[1] $taskData.bytes }
$taskWeightUri=$taskQ+'model.safetensors'
$taskPrefix=Read-PinnedSource $taskWeightUri 8 'bytes=0-7'
if ($taskPrefix.bytes.Length -ne 8 -or $taskPrefix.contentRange -notlike 'bytes 0-7/*') { throw 'Invalid safetensors prefix range' }
$taskHeaderLength=[BitConverter]::ToUInt64($taskPrefix.bytes,0)
if ($taskHeaderLength -lt 1 -or $taskHeaderLength -gt 2000000) { throw 'Header exceeds metadata budget' }
$taskEnd=7+$taskHeaderLength
$taskHeader=Read-PinnedSource $taskWeightUri ([int]$taskHeaderLength) ('bytes=8-'+$taskEnd)
if ($taskHeader.bytes.Length -ne $taskHeaderLength -or $taskHeader.contentRange -notlike ('bytes 8-'+$taskEnd+'/*')) { throw 'Invalid safetensors header range' }
[System.Text.Encoding]::UTF8.GetString($taskHeader.bytes) | ConvertFrom-Json -AsHashtable | Out-Null
Save-PinnedSource 'references/models/qwen3-0.6b/safetensors-header.json' ($taskWeightUri+'#metadata-only-range-8-'+$taskEnd) $taskHeader.bytes
$taskLock=@{schemaVersion=1;checkedOn=[DateTime]::UtcNow.ToString('yyyy-MM-dd');pins=$taskPins;records=@($taskRecords.ToArray())}
$taskLock | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath 'references/models/source-lock.json' -Encoding utf8
Write-Output ('Pinned '+$taskRecords.Count+' metadata/source files; no tensor weight payload downloaded.')
