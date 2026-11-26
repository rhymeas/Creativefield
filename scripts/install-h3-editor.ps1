# Installs the pinned H3 Editor into the HyperFlow ComfyUI worker and applies CreativeField's
# adaptations: project mapping from ?project=cf-<id>, and the #ds theme. Python dependencies are
# checked but never installed into a uv-managed interpreter; use the worker venv.
#
#   pwsh -File scripts/install-h3-editor.ps1 -WorkerRoot <worker ComfyUI folder> -PythonExe <worker venv python.exe>
#   Or set CREATIVEFIELD_H3_WORKER and CREATIVEFIELD_H3_PYTHON once. -SourceRepo reuses a local checkout.
param(
  [string]$WorkerRoot = $env:CREATIVEFIELD_H3_WORKER,
  [string]$SourceRepo = '',
  [string]$PythonExe = $env:CREATIVEFIELD_H3_PYTHON
)
$ErrorActionPreference = 'Stop'
if (-not $WorkerRoot) { throw 'Name the HyperFlow worker ComfyUI folder: -WorkerRoot <folder>, or set CREATIVEFIELD_H3_WORKER.' }
$commit = '60c1784'
$repoRoot = Split-Path $PSScriptRoot -Parent
$target = Join-Path $WorkerRoot 'custom_nodes\comfyui-h3-editor'
$editorJs = Join-Path $target 'editor\editor.js'
$editorCss = Join-Path $target 'editor\editor.css'
$theme = Join-Path $repoRoot 'scripts\h3-editor-theme.css'

# The #ds theme is the last block of editor.css. Each run replaces that block with the current
# scripts/h3-editor-theme.css, so a theme change reaches an installed editor without a reinstall.
function Set-CreativeFieldTheme {
  $css = Get-Content $editorCss -Raw
  $at = $css.IndexOf('CreativeField (#ds) theme for the embedded H3 Editor')
  if ($at -ge 0) { $css = $css.Substring(0, $css.LastIndexOf('/*', $at)).TrimEnd() }
  Set-Content -Path $editorCss -Value "$css`n`n$(Get-Content $theme -Raw)" -NoNewline -Encoding utf8
}

# The release label in the editor bar links to the upstream project (credit for the GPL-3.0 editor).
$editorHtml = Join-Path $target 'editor\index.html'
# The CreativeField embed script (scripts/h3-editor-embed.js) sits before </body> between markers and is replaced on
# every run, like the theme: one quiet top bar when the editor is embedded in a CreativeField project.
function Set-CreativeFieldEmbed {
  $html = Get-Content $editorHtml -Raw
  $start = '<!-- CreativeField embed -->'; $end = '<!-- /CreativeField embed -->'
  $at = $html.IndexOf($start)
  if ($at -ge 0) { $stop = $html.IndexOf($end, $at); $html = $html.Remove($at, $stop + $end.Length - $at) }
  # The Film Studio additions' UI (Grade, Resolve/Premiere export) follows the embed script in the same block.
  $script = (Get-Content (Join-Path $repoRoot 'scripts\h3-editor-embed.js') -Raw) + "`n" + (Get-Content (Join-Path $repoRoot 'scripts\h3-editor-grade.js') -Raw)
  $html = $html.Replace('</body>', "$start<script>`n$script</script>$end`n</body>")
  Set-Content -Path $editorHtml -Value $html -NoNewline -Encoding utf8
}

function Set-CreativeFieldLinks {
  $html = Get-Content $editorHtml -Raw
  $label = '<span class="release" title="The version of H3 Editor this is">H3 Editor __RELEASE__</span>'
  $link = '<a class="release" href="https://github.com/igorls/comfyui-h3-editor" target="_blank" rel="noopener noreferrer" title="H3 Editor by Igor LS on GitHub">H3 Editor __RELEASE__</a>'
  if ($html.Contains($label)) { Set-Content -Path $editorHtml -Value $html.Replace($label, $link) -NoNewline -Encoding utf8 }
}

# CreativeField's Film Studio additions (sound fades, grading, NLE export) live in scripts/h3-editor-cf: their own
# modules beside the editor plus small checked hooks. apply.py is idempotent and stops when upstream text has moved.
function Set-CreativeFieldAdditions {
  $python = if ($PythonExe -and (Test-Path $PythonExe)) { $PythonExe } else { 'python' }
  & $python (Join-Path $repoRoot 'scripts\h3-editor-cf\apply.py') $target
  if ($LASTEXITCODE -ne 0) { throw 'The CreativeField Film Studio additions could not be applied; see the message above.' }
}

# Film Studio reference takes render through BExplains RefPacks (MIT; scripts/h3-editor-cf/cf_refpacks.py). Its two
# node packs are installed beside the editor at pinned commits when missing; without them every clip keeps H3 Take.
$refPacks = @(
  @{ Folder = 'BExplains_RefPacks'; Url = 'https://github.com/BExplains/ComfyUI-RefPacks.git'; Commit = '6269de6' },
  @{ Folder = 'BExplains_H3_RefPacks'; Url = 'https://github.com/BExplains/ComfyUI-MiniMax-H3-RefPacks.git'; Commit = 'a93dc65' }
)
function Set-RefPacks {
  foreach ($pack in $refPacks) {
    $folder = Join-Path $WorkerRoot (Join-Path 'custom_nodes' $pack.Folder)
    if (Test-Path (Join-Path $folder '__init__.py')) { continue }
    $source = Join-Path ([IO.Path]::GetTempPath()) ($pack.Folder + '-src')
    if (-not (Test-Path (Join-Path $source '.git'))) { git clone --quiet $pack.Url $source }
    git -C $source fetch --quiet origin
    git -C $source checkout --quiet $pack.Commit
    if ($LASTEXITCODE -ne 0) { throw "RefPacks commit $($pack.Commit) not found in $($pack.Url)." }
    New-Item -ItemType Directory -Force -Path $folder | Out-Null
    Copy-Item (Join-Path $source '*') $folder -Recurse -Force -Exclude '.git', 'tests', '.github'
    Write-Host "Installed $($pack.Folder) at $($pack.Commit)."
  }
}

if (Test-Path $editorJs) {
  Set-CreativeFieldTheme
  Set-CreativeFieldLinks
  Set-CreativeFieldEmbed
  Set-CreativeFieldAdditions
  Set-RefPacks
  Write-Host "H3 Editor is already installed at $target; theme and CreativeField additions refreshed."
  exit 0
}

if (-not $SourceRepo) {
  $SourceRepo = Join-Path ([IO.Path]::GetTempPath()) 'comfyui-h3-editor-src'
  if (-not (Test-Path (Join-Path $SourceRepo '.git'))) {
    git clone --quiet https://github.com/igorls/comfyui-h3-editor.git $SourceRepo
  }
  git -C $SourceRepo fetch --quiet origin $commit
  git -C $SourceRepo checkout --quiet $commit
}
if (-not (Test-Path (Join-Path $SourceRepo 'editor\editor.js'))) {
  throw "No H3 Editor source at $SourceRepo"
}

New-Item -ItemType Directory -Force -Path $target | Out-Null
Copy-Item (Join-Path $SourceRepo '*') $target -Recurse -Force -Exclude '.git', 'tests', '.github', 'colab'

# 1. CreativeField project mapping: the host opens .../h3take/editor?project=cf-<projectId>.
$js = Get-Content $editorJs -Raw
$oldStart = @'
async function start() {
  let remembered = null;
  try { remembered = localStorage.getItem("h3take.project"); } catch (_) {}
  const projects = await refreshProjects(remembered);
  if (!projects.length) await createProject("First scene");
  else await openProject(projects.includes(remembered) ? remembered : projects[0]);
  connect();
}
'@
$newStart = @'
async function start() {
  let remembered = null;
  try { remembered = localStorage.getItem("h3take.project"); } catch (_) {}
  // CreativeField passes its project as ?project=cf-<id>; create it once, then always reopen it.
  let wanted = null;
  try { wanted = new URLSearchParams(location.search).get("project"); } catch (_) {}
  if (wanted) remembered = wanted;
  const projects = await refreshProjects(remembered);
  if (!projects.length) await createProject(wanted || "First scene");
  else if (wanted && !projects.includes(wanted)) await createProject(wanted);
  else await openProject(projects.includes(remembered) ? remembered : projects[0]);
  connect();
}
'@
if (-not $js.Contains($oldStart)) {
  throw "The upstream editor.js start() does not match the pinned $commit; update the installer."
}
$js = $js.Replace($oldStart, $newStart)

# 2. Same-origin hosting: every API/media/socket path follows /h3-editor/<workspaceId>.
$viewOld = 'const viewUrl = (file, subfolder) => "/view?type=output&filename=" + encodeURIComponent(file) + "&subfolder=" + encodeURIComponent(subfolder || "");'
$viewNew = @'
const h3base = (() => { const match = location.pathname.match(/^\/h3-editor\/[0-9a-f-]{36}/i); return match ? match[0] : ""; })();
const viewUrl = (file, subfolder) => h3base + "/view?type=output&filename=" + encodeURIComponent(file) + "&subfolder=" + encodeURIComponent(subfolder || "");
'@
if (-not $js.Contains($viewOld)) {
  throw "The upstream editor.js viewUrl does not match the pinned $commit; update the installer."
}
$js = $js.Replace($viewOld, $viewNew.TrimEnd())
$js = $js.Replace('fetch("/h3take/api" + path', 'fetch(h3base + "/h3take/api" + path')
$js = $js.Replace('location.host + "/ws?clientId="', 'location.host + h3base + "/ws?clientId="')
$js = $js.Replace('link.href = "/h3take/api/project/', 'link.href = h3base + "/h3take/api/project/')
$js = $js.Replace('request.open("POST", "/h3take/api/projects/open?', 'request.open("POST", h3base + "/h3take/api/projects/open?')

# 3. Canvas colours that are not CSS variables.
$js = $js.Replace('context.fillStyle = selected ? "#8fd6c8" : "#5fae9f";', 'context.fillStyle = selected ? "#8fd0ff" : "#3f83b2";')
$js = $js.Replace("else { c.fillStyle = '#1b1e23'; c.fillRect(0, 0, w, h); }", "else { c.fillStyle = '#0f1113'; c.fillRect(0, 0, w, h); }")
$js = $js.Replace("color: { type: 'color', default: '#ece8df' },", "color: { type: 'color', default: '#f7f7f8' },")
$js = $js.Replace('const NOTE_INK = "#ffb547";', 'const NOTE_INK = "#2fa8ff";')
Set-Content -Path $editorJs -Value $js -NoNewline -Encoding utf8

# 4. #ds theme: colours, radius, font.
Set-CreativeFieldTheme

Write-Host "Installed H3 Editor at $target"
Write-Host "Project mapping: ?project=cf-<projectId> is created once and reopened."
Write-Host "Same-origin hosting: /h3-editor/<workspaceId>/h3take/editor."
Set-CreativeFieldLinks
Set-CreativeFieldEmbed
Set-CreativeFieldAdditions
Set-RefPacks
Write-Host "Theme: scripts/h3-editor-theme.css appended to editor/editor.css."

if ($PythonExe -and (Test-Path $PythonExe)) {
  & $PythonExe -c "import imageio_ffmpeg, gguf" 2>$null
  if ($LASTEXITCODE -ne 0) {
    Write-Host "Missing Python dependencies. In the worker venv run:"
    Write-Host "  $PythonExe -m pip install imageio-ffmpeg>=0.5 gguf>=0.13.0"
  } else {
    Write-Host "Python dependencies: present."
  }
} else {
  Write-Host "Python executable not found at $PythonExe; check the worker venv."
}
Write-Host "Restart the HyperFlow worker, then verify http://127.0.0.1:8309/h3take/editor."
