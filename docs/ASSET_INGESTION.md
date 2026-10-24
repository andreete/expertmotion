# Asset Ingestion: import pipeline, formats, limits, storage, failure cases

| Field | Value |
|---|---|
| Status | baseline (FFmpeg commands to be validated on the Windows QA machine in Stage 2; budgets in PERFORMANCE.md §5) |
| Owner | Engine lead (Local Service `ingest` module) |
| Last updated | 2026-10-24 |
| Depends on | GLOSSARY.md, PRD.md (PRD-005, PRD-006), ARCHITECTURE.md (§4 `ingest`, §8 filesystem, §9), PERFORMANCE.md (§3 Auto ratio, §5 budgets), REMOTION_CAPABILITY_MAP.md (§C media, §G FFmpeg), ELEMENT_IDS.md (`lib.assets.*`), DECISIONS.md (ADR-005, ADR-006) |
| Used by | API_SPECIFICATION.md (routes, SSE events), DATABASE_SCHEMA.md (`assets` table), UI_UX_SPECIFICATION.md (Asset Panel), ERROR_CATALOGUE.md (`EM-1xxx`), TEST_PLAN.md, SECURITY.md, DEPLOYMENT_AND_PACKAGING.md (FFmpeg build) |
| Owner of | accepted formats and limits, the ingest pipeline steps and exact FFmpeg/ffprobe invocations, the copy policy, the media storage layout, dedupe, the Asset metadata contract, the `Auto` ratio rule, the ingest failure table |

An **Asset** (GLOSSARY.md) is the result of this pipeline: an imported media file with probe metadata, proxy, thumbnail and waveform on the filesystem and a row in the index. Ingestion never touches the Composition Model; `Insert` (`op:clip.insert`) does. Error codes `EM-1001` … `EM-1010` are **proposed** for ERROR_CATALOGUE.md (which owns them); `EM-1301` (asset missing) is already referenced by PERFORMANCE.md §7.

---


> **Stage 3 reconciliation (2026-10-24).** Where this document differs from API_SPECIFICATION.md or ERROR_CATALOGUE.md, those owners win and the service follows them: SSE events are `ingest.progress`, `ingest.done`, `ingest.failed` (not `asset.*`); variant names are `original`, `playable`, `proxy`, `thumb`, `filmstrip`, `waveform` (files `strip.jpg`/`wave.json` keep their names on disk); error meanings are those of ERROR_CATALOGUE (clips longer than the limit use EM-1011). Remotion's slim FFmpeg lacks the `fps`/`tile` filters and the `s16le`/`ipod` muxers: on that build the filmstrip is skipped with EM-1005, the waveform is read from a WAV pipe and `.m4a` is written with `-f mp4`; the full LGPL ingestion build (ADR-019) restores the filmstrip.
## 1. Accepted containers and codecs

| Kind | Containers | Codecs accepted by the probe | Result after ingest |
|---|---|---|---|
| Video | MP4 (`mov,mp4,m4a,3gp,3g2,mj2`), MOV, MKV (`matroska,webm`), WebM | H.264/AVC, H.265/HEVC, VP9, AV1, ProRes (all profiles); any yuv 4:2:0/4:2:2/4:4:4, 8–12 bit, SDR or HDR (HLG/PQ); constant or variable frame rate; 0–n audio streams (first stream used) | original kept; a **playable copy** `playable.mp4` (H.264 yuv420p + AAC) when the original is not already that; a 720p proxy; thumbnails; waveform if audio |
| Image | PNG, JPEG, WebP (still), GIF (still or animated), AVIF (still or animated), APNG | — | original kept; `proxy.jpg` (≤ 1920 px long side, EXIF-free) for stills; animated GIF/WebP/AVIF/APNG are kept as-is for `<AnimatedImage>` plus a still poster |
| Audio | MP3, WAV, AAC (`.aac`, ADTS), M4A, OGG (Vorbis/Opus), FLAC | MP3, PCM (8/16/24/32-bit, float), AAC, Vorbis, Opus, FLAC | original kept; `playable.m4a` (AAC 160 kbps) when the original is not MP3/AAC; waveform JSON |

Detection is by probe (`format_name`, `codec_name`), never by file extension alone; the extension is only used for the first quick reject. PRD-005 lists the same families without AVIF and FLAC; both are accepted here because they cost nothing with the full FFmpeg build (see Inconsistencies in the handover note).

Not accepted (rejected with `EM-1001` and the reason text): raw camera formats (`.braw`, `.r3d`), project files, PDF, SVG (P2 candidate via rasterisation), subtitle files are accepted elsewhere (`op:caption.importSrt`), encrypted or DRM-protected media, files with 0 streams.

## 2. Limits

| Limit | Value | Enforced at | Error |
|---|---|---|---|
| File size | ≤ 4 GB | step 1 (`fs.stat`) | `EM-1002` |
| Duration | ≤ 30 min (1 800 000 ms) per video/audio file | step 2 (probe) | `EM-1003` |
| Image dimensions | ≤ 8 192 px on either side (larger images are rejected, not downscaled, so that "original kept" stays true) | step 2 | `EM-1008` (proposed) |
| Video dimensions | ≤ 7 680 × 4 320 (8K) and ≥ 64 px | step 2 | `EM-1001` with reason "dimensions" |
| Assets per Project | ≤ 200 | before step 1 | `EM-1007` (proposed) |
| Concurrent ingests | 2 (ARCHITECTURE.md §9); paused during Standard/Accelerated renders (PERFORMANCE.md §2) | queue | — |
| Disk | free space ≥ 2 × original size + 500 MB before copying | step 1 | `EM-1006` |
| Path/name | file name sanitised (`sanitizeFilename`, ported), ≤ 120 characters; original name kept in the index for display | step 1 | — |

## 3. Pipeline

Two FFmpeg builds exist in the app (REMOTION_CAPABILITY_MAP.md §G, ASSESSMENT.md §4): Remotion's **slim** build inside the platform compositor package `@remotion/compositor-win32-x64-msvc` covers Remotion's output codecs only and is used by the renderer; **ingestion always uses Expertmotion's bundled full FFmpeg/ffprobe** (`resources/bin/ffmpeg-full/ffmpeg.exe`, `ffprobe.exe`; FFmpeg 7.1 line with libdav1d, libzimg, libvpx, libopus, libaom-decode for AV1/HDR/FLAC/ProRes sources). The full build is **LGPL-configured** (no `--enable-gpl`, no `--enable-nonfree`), so it contains **no libx264** unless the Operator accepts the GPL handling of BRD.md §6.1 / LOCAL_AI_MODELS.md §3.4 for it; the exact build flags, source and sha256 are pinned in DEPLOYMENT_AND_PACKAGING.md B4. Consequence for §4: the `-c:v libx264` encode of the playable copy and the proxy either runs on a GPL-handled full build or is delegated to the compositor's slim FFmpeg (H.264 output is in the slim build) after the full build has decoded the source; which of the two is chosen is an open B4 packaging decision (DEPLOYMENT_AND_PACKAGING.md B4, BRD.md §6.1 legal review), and the command lines below are written for the libx264 encoder in either case. All spawns use `child_process.spawn` with an argument array, `windowsHide: true`, a per-job `cwd`, and the minimal environment defined in LOCAL_AI_MODELS.md §3.2. Still images are processed with `sharp` (Apache-2.0, prebuilt libvips) instead of FFmpeg because it applies EXIF orientation, strips metadata and resizes in one pass; animated images and everything else go through FFmpeg.

Each import is a **job** (same envelope as generator jobs, LOCAL_AI_MODELS.md §8): `{jobId, projectId, assetId, status, stage, percent, eta, error}`. Progress is pushed over SSE as `asset.progress`; the Asset card shows `lib.assets.card.state.ingesting` with the stage name.

| # | Stage | What happens | Output |
|---|---|---|---|
| 1 | validate and hash | extension/size/count/disk checks; **copy** the file into `media\<projectId>\<assetId>\original.<ext>` with a streaming sha256 computed during the copy (`fs.createReadStream` → `crypto.createHash('sha256')` → `fs.createWriteStream`); the hash is compared with existing assets of the Project (§5 dedupe) | `original.<ext>`, `sha256` |
| 2 | probe | `ffprobe` (§3.2); classify kind; apply limits; extract rotation, fps mode, HDR flags, audio presence | `probe.json` (raw) + normalised `AssetMeta` (§7) |
| 3 | decide transcode | §3.3 rule | plan: `{needsPlayable, needsProxy, needsThumbs, needsWaveform, tonemap, cfr}` |
| 4 | transcode (playable copy) | §3.4, only when needed | `playable.mp4` / `playable.m4a` |
| 5 | proxy | §3.5 for video; `sharp` resize for stills | `proxy.mp4` / `proxy.jpg` |
| 6 | thumbnails | §3.6 | `thumb.jpg` (poster) + `strip.jpg` (8 frames) |
| 7 | waveform | §3.7 for anything with audio | `wave.json` |
| 8 | index + events | write the `assets` row in one transaction (DATABASE_SCHEMA.md), mark `ready`; SSE `asset.ready {assetId, meta}`; on any failure SSE `asset.failed {assetId, code}` and the folder is removed except `original.<ext>` when the failure is in steps 4–7 (so the Creator can retry without re-copying) | DB row, events |

Stages 5–7 run after the playable copy exists and read from it (or from the original when no copy was needed), so every derived file comes from one decodable source. Stage order within a job is sequential; two jobs run in parallel at most.

### 3.1 Step 1: validate and hash (exact behaviour)

```ts
// pseudo-code of the copy+hash step
const hash = createHash('sha256');
await pipeline(createReadStream(src, {highWaterMark: 1 << 20}),
  new Transform({transform(chunk, _, cb) { hash.update(chunk); cb(null, chunk); }}),
  createWriteStream(dst, {flags: 'wx'}));                  // 'wx': never overwrite
const sha256 = hash.digest('hex');
```

Copy throughput sets the budget: a 1 GB file on an SSD copies in ≈ 3–5 s; progress for this stage is bytes copied / size.

### 3.2 Step 2: probe

```
ffprobe -v error -print_format json -show_format -show_streams -show_entries stream_side_data=rotation,displaymatrix:format_tags=creation_time -i "<original>"
```

Fields read (and how they are used):

| ffprobe field | Use |
|---|---|
| `format.format_name`, `format.duration`, `format.size`, `format.bit_rate` | kind, duration limit, metadata card |
| `streams[codec_type=video][0].codec_name`, `.profile`, `.width`, `.height`, `.pix_fmt`, `.bit_depth`/`.bits_per_raw_sample` | transcode decision, dimensions |
| `.r_frame_rate`, `.avg_frame_rate`, `.nb_frames` | fps; **VFR detection**: `r_frame_rate ≠ avg_frame_rate` (difference > 0.5 %) or `nb_frames` inconsistent with `duration × fps` (§6) |
| `.side_data_list[].rotation` / `displaymatrix` | display dimensions after rotation (phone clips: 1920×1080 with rotation −90 → display 1080×1920) |
| `.color_transfer` (`smpte2084`, `arib-std-b67`), `.color_primaries` (`bt2020`), `.color_space` | HDR detection → tone-map (§6) |
| `.disposition.attached_pic` | ignore cover-art "video" streams in audio files |
| `streams[codec_type=audio][0].codec_name`, `.channels`, `.sample_rate`, `.duration` | `hasAudio`, waveform, audio-only classification |
| image: `codec_name` (`png`, `mjpeg`, `webp`, `gif`, `av1`/`avif`, `apng`), `nb_frames` > 1 or `duration` > 0 → animated | still vs animated image |

Timeout 30 s; a non-zero exit, no streams, or unparsable JSON → `EM-1004` "The file could not be read. It may be damaged or not a media file."

### 3.3 Step 3: decide transcode (rule)

| Condition (all must hold to **skip** transcoding) | Otherwise |
|---|---|
| container `mp4`/`mov` with `format_name` containing `mp4` | → `playable.mp4` |
| video `codec_name == 'h264'`, `pix_fmt == 'yuv420p'`, 8-bit, SDR, constant frame rate | → `playable.mp4` |
| audio absent, or `codec_name == 'aac'` with ≤ 2 channels | → `playable.mp4` (video) / `playable.m4a` (audio-only unless MP3/AAC already) |
| `moov` atom at the front (`ffprobe` cannot tell directly; the copy is checked by reading the first 64 kB for `moov` before `mdat`) | → remux only: `ffmpeg -v error -i original.mp4 -c copy -movflags +faststart playable.mp4` |

The original is **always kept**; `playable.*` is an additional file. The Engine (`<Video>`/`<Audio>` URLs) and all derived files use `playable.*` when it exists, else the original. Rationale: `@remotion/media` decodes through Chromium's WebCodecs; H.264 yuv420p + AAC in a fast-start MP4 is the one combination that decodes with hardware or fast software paths in both Electron and Chrome Headless Shell (HEVC in particular depends on OS codecs; AV1/VP9/ProRes 4:2:2/10-bit are slow or unsupported), and it is what the book calls "format yang paling aman" (§6.7).

### 3.4 Step 4: transcode (exact command)

```
ffmpeg -v error -nostdin -y -progress pipe:1 -i "<original>" \
  -map 0:v:0 -map 0:a:0? \
  -c:v libx264 -preset veryfast -crf 20 -pix_fmt yuv420p -profile:v high -level 4.2 \
  -vf "<filters>" -fps_mode cfr -r <fps> \
  -c:a aac -b:a 160k -ac 2 -ar 48000 \
  -map_metadata -1 -movflags +faststart \
  "<assetDir>\playable.mp4"
```

| Part | Rule |
|---|---|
| `-map 0:a:0?` | first audio stream, optional; additional streams are dropped (Clip `volume` is per Clip, not per stream) |
| `<filters>` | always `scale=trunc(iw/2)*2:trunc(ih/2)*2` (even dimensions for yuv420p); plus `transpose` is **not** needed: FFmpeg auto-rotates by the display matrix by default (`-autorotate` on), so the playable copy has the display orientation and no rotation tag; plus the HDR tone-map chain (§6) when `tonemap` is set; plus `scale=-2:4320` cap if taller than 8K is impossible by the limits, so no cap is needed |
| `-fps_mode cfr -r <fps>` | `<fps>` = `avg_frame_rate` rounded to the nearest of 23.976/24/25/29.97/30/50/59.94/60; converts VFR to CFR (§6) |
| `-crf 20 -preset veryfast` | visually near-lossless for an intermediate, ≈ 2–4× realtime on T0 for 1080p **[estimate; PERFORMANCE.md §5 budget: 1 min 1080p30 ingest ≤ 20 s total]** |
| `-map_metadata -1` | strips container/stream metadata (EXIF, GPS, camera make, creation time) from the derived file (§10) |
| `-progress pipe:1` | `out_time_us` lines → percent = `out_time / duration` |
| Level/profile | `high@4.2` for ≤ 1080p60; `-level 5.1` when > 1080p or > 60 fps (chosen from probe) |
| Audio-only input | same command without `-map 0:v:0`, `-c:v`, `-vf`, `-fps_mode`; output `playable.m4a` with `-movflags +faststart` |
| Timeout | `max(120 s, 4 × duration)`; kill tree on expiry → `EM-1005` |
| Exit ≠ 0 | `EM-1005` "Could not convert this file" with the last 10 stderr lines in Diagnostics; original kept |
| Disk full mid-write (ENOSPC in stderr or write error) | `EM-1006`; partial output deleted |

### 3.5 Step 5: proxy 720p (video)

```
ffmpeg -v error -nostdin -y -progress pipe:1 -i "<playable or original>" \
  -map 0:v:0 -map 0:a:0? \
  -vf "scale='if(gte(iw,ih),-2,720)':'if(gte(iw,ih),720,-2)':flags=bicubic" \
  -c:v libx264 -preset veryfast -crf 28 -pix_fmt yuv420p -g 30 -keyint_min 30 \
  -c:a aac -b:a 96k -ac 2 -ar 48000 -map_metadata -1 -movflags +faststart \
  "<assetDir>\proxy.mp4"
```

The scale expression keeps the **short side** at 720 so a 9:16 clip becomes 720×1280 (matching the Draft row of PERFORMANCE.md §3), while a 16:9 clip becomes 1280×720 (`scale=-2:720`). Short GOP (`-g 30`) keeps Player seeks ≤ 100 ms (PERFORMANCE.md §5). Skipped when the playable copy already has short side ≤ 720 (the playable copy is then also the proxy). Images: `proxy.jpg` via `sharp(original).rotate().resize({width: 1920, height: 1920, fit: 'inside', withoutEnlargement: true}).jpeg({quality: 85})` — `sharp` strips EXIF unless `withMetadata()` is called, which it is not. Animated images: no proxy (served as-is to `<AnimatedImage>`); a still poster only.

### 3.6 Step 6: thumbnails

| Output | Command | Notes |
|---|---|---|
| Poster `thumb.jpg` at 35 % of duration | `ffmpeg -v error -nostdin -y -ss <0.35 × duration s> -i "<playable>" -frames:v 1 -vf "scale=-2:360" -q:v 3 "<assetDir>\thumb.jpg"` | 35 % avoids black/fade-in starts; the same 35 % rule is used for Output thumbnails (`renderStill`) so Asset and Output cards look alike; images: `sharp` resize to 360 px height |
| Filmstrip `strip.jpg` (8 frames in one row) | `ffmpeg -v error -nostdin -y -i "<playable>" -vf "fps=8/<duration s>,scale=160:-2,tile=8x1" -frames:v 1 -q:v 4 "<assetDir>\strip.jpg"` | shown on hover and in the Timeline View clip bar; for clips < 2 s, `fps=8/duration` still yields 8 samples |
| Audio-only | no frames; the Asset card draws the waveform (`wave.json`) over a kind-coloured background | — |

### 3.7 Step 7: waveform JSON (100 samples per second)

Peaks are computed from mono PCM piped out of FFmpeg and reduced in Node, which is deterministic and needs no extra tool:

```
ffmpeg -v error -nostdin -i "<playable or original>" -vn -map 0:a:0 -ac 1 -ar 8000 -f s16le -c:a pcm_s16le pipe:1
```

Node reads the stream in windows of 80 samples (8 000 Hz ÷ 100 windows/s), stores `max(|sample|)` of each window as an 8-bit value (0–255) and writes:

```json
{ "version": 1, "sampleRate": 100, "channels": 1, "bits": 8, "lengthMs": 63400, "peaks": [0, 3, 18, 44, "…"] }
```

Size ≈ 100 bytes per second of audio before JSON overhead (a 30-minute file ≈ 500 kB, acceptable). An `astats`-based alternative (`-af asetnsamples=80,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.Peak_level:file=-`) produces the same information but is slower to parse; the PCM pipe is the reference implementation. Silence detection for the Audio sub-agent (ducking spans) reuses `peaks` with a −40 dBFS threshold; it is not a separate pass.

### 3.8 Step 8: index write and SSE events

| Event | Payload | When |
|---|---|---|
| `asset.queued` | `{assetId, projectId, name, size}` | before step 1 |
| `asset.progress` | `{assetId, stage: 'copy'|'probe'|'transcode'|'proxy'|'thumbs'|'waveform'|'index', percent, eta}` | throttled to 500 ms |
| `asset.ready` | `{assetId, meta: AssetMeta}` | after the DB transaction commits |
| `asset.failed` | `{assetId, code: 'EM-1xxx', message}` | on any failure |
| `asset.duplicate` | `{assetId: existing, name}` | §5 |
| `asset.removed` | `{assetId}` | on delete |

The `assets` row (DATABASE_SCHEMA.md owns the DDL) stores: ids, project, kind, original name, sha256, sizes, `AssetMeta` JSON, file list with per-file sha256 for derived files, state (`ingesting`, `ready`, `failed`, `missing`), timestamps. The transaction is written **only** after every file exists on disk, so a crash leaves at worst orphan files that the startup sweep deletes (folders without a `ready` row older than 1 h).

## 4. Copy vs link policy: always copy

Expertmotion copies every imported file into app data and never references the Creator's original path. Reasons:

| Reason | Detail |
|---|---|
| Durability | USB drives, phones and network shares disappear; a Project must open and render later (PRD-003 recovery, PRD-014 render success) |
| Integrity | the sha256 of the copy is the identity of the Asset; a file edited in place elsewhere would silently change the video |
| Security | the Local Service serves only paths under `media\` (ADR-005 path restriction); linking would require serving arbitrary user paths |
| Backup/Restore | `hdr.action.backup` zips `media\<projectId>` with the database; links would break on another machine |
| Cost | disk is the cheapest resource in this design; the proxy/playable copies dominate anyway |

Consequence stated in the UI (`lib.assets.drop` hint): "Files are copied into the project (originals are not modified)." A P2 "relink from folder" exists only for recovering `EM-1301` (asset missing) when a Creator deleted app data by hand.

## 5. Storage layout and dedupe

```
%APPDATA%\Expertmotion\media\<projectId>\<assetId>\
  original.<ext>      byte-identical copy (sha256 = Asset identity)
  playable.mp4|m4a    only when §3.3 required it
  proxy.mp4|jpg       720p short side / 1920 px image
  thumb.jpg           poster (360 px high)
  strip.jpg           8-frame filmstrip (video)
  wave.json           peaks, 100/s (anything with audio)
  probe.json          raw ffprobe output (Diagnostics)
  captions.json       raw Caption[] after captions.generate (LOCAL_AI_MODELS.md)
```

`assetId` is a random 128-bit id (ARCHITECTURE.md §7: unguessable media URLs `/media/<assetId>/<variant>`). Served variants: `original`, `playable`, `proxy`, `thumb`, `strip`, `wave`; the Local Service maps variant → file and sends `Content-Type`, `Accept-Ranges: bytes` and `Cache-Control: private, max-age=31536000, immutable` (files never change after `ready`).

Dedupe: if the sha256 of a new import equals an existing `ready` Asset **in the same Project**, the copy is deleted, the existing Asset is selected in the Asset Panel and `asset.duplicate` is emitted (toast "Already imported as <name>"); no error. Across Projects there is no dedupe in MVP (Projects are independent for backup and deletion; P2 may add a content-addressed store). Generated assets (voice, music, thumbnails) use the same layout with `original.<ext>` being the generated file.

Deleting an Asset that is referenced by a Clip is refused with a list of the Clips (`op:clip.remove` first); deleting a Project deletes its media folder after the database row is gone.

## 6. Special cases

| Case | Handling |
|---|---|
| Variable frame rate (phone screen recordings, WhatsApp videos) | detected in step 2; the playable copy is forced to CFR (`-fps_mode cfr -r <fps>`), duplicating/dropping frames so that `trimBeforeMs`→frame conversion in the Engine is exact; the card shows "converted to constant frame rate" in `lib.assets.card.meta` |
| HDR (HLG/PQ, BT.2020, 10-bit) | tone-mapped to SDR BT.709 in the playable copy with `zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p` (requires libzimg in the FFmpeg build; `libplacebo` is the alternative); the original stays HDR; meta shows "HDR → SDR" |
| Rotated phone video | auto-rotated into the playable copy; `AssetMeta.width/height` are display dimensions; the Auto ratio (§8) uses them |
| Audio-only files | kind `audio`; inserted as **Audio Layers** (`op:audio.addLayer` or `op:audio.addBed`), never as Clips; the Asset card shows the waveform |
| Images (still) | default Clip/Overlay duration **5 000 ms** (`op:clip.insert` fills `durationMs` from `AssetMeta.durationMs = 5000` for stills); `<Img>` with `objectFit` (REMOTION_CAPABILITY_MAP.md §C.3) |
| GIF / animated WebP / animated AVIF / APNG | kind `animated-image`; `AssetMeta.durationMs` = animation length from probe (loops by default when the Clip is longer); rendered with `<AnimatedImage loopBehavior="loop">`; no transcode (transcoding would lose the alpha and the loop) |
| Video without audio | `hasAudio: false`; `<Video muted>`; ducking ignores it |
| Multiple audio streams | first stream only (noted in meta) |
| Cover art in audio files | `attached_pic` stream ignored; the poster is the waveform card, not the cover (P2 may show the cover) |
| Very short video (< 1 s) | accepted; filmstrip samples repeat frames |
| Transparent video input (WebM VP9 alpha, ProRes 4444) | the playable copy is yuv420p and **loses alpha** in MVP; meta shows "transparency removed"; P2: keep a VP9-alpha playable copy when alpha is detected (`pix_fmt` contains `a`) |
| Cancellation | the Creator cancels from the card: current child process killed (`taskkill /T /F`), partial files and the folder deleted, job `cancelled`, `asset.removed` emitted; the original copy is deleted too (the Creator can re-import) |
| Service restart mid-ingest | on startup, rows in state `ingesting` are set to `failed` (`EM-1005` "interrupted") and their folders swept unless `original.<ext>` + `probe.json` exist, in which case the job is re-queued from step 3 |

## 7. Asset metadata contract (`lib.assets.card.meta`)

```ts
type AssetMeta = {
  kind: 'video' | 'image' | 'animated-image' | 'audio';
  name: string;                 // original file name (sanitised for display)
  bytes: number;                // original size
  durationMs: number;           // video/audio/animated; 5000 for stills (default insert duration)
  width?: number; height?: number;   // display dimensions after rotation
  fps?: number;                 // playable copy fps (CFR); original avg fps in probe.json
  codec?: string;               // original codec, e.g. "hevc", "av1", "png"
  pixFmt?: string; bitDepth?: number; hdr?: boolean;
  hasAudio: boolean; audioCodec?: string; channels?: number; sampleRate?: number;
  vfr: boolean; rotated: boolean; transcoded: boolean; alphaRemoved: boolean;
  sha256: string;
  files: { original: string; playable?: string; proxy?: string; thumb?: string; strip?: string; wave?: string };
  importedAt: string;
};
```

Card tooltip (`lib.assets.card.meta`) shows: resolution (`1080×1920`), fps (`30`), duration (`mm:ss`), audio (`stereo 48 kHz` / `no audio`), size (`48.2 MB`), plus badges `converted` / `HDR→SDR` / `CFR` when relevant (EN strings with ID variants per ADR-012; copy owned by UI_UX_SPECIFICATION.md).

## 8. `Auto` Aspect Ratio detection

When `agent.output.ratio.auto` is on, the first `op:clip.insert` into an empty Sequence sets the Project ratio from that Asset's display `width/height` to the nearest of the seven ratios by absolute difference of aspect values (PERFORMANCE.md §3; ported `detectFormat` extended from four to seven ratios):

| Asset aspect (w/h) | Picked | Example |
|---|---|---|
| ≥ 1.555 | 16:9 (1.778) | 1920×1080, 3840×2160, 1440×900 (1.6) |
| 1.3 … 1.555 | 4:3 (1.333) | 1440×1080, 4000×3000 photos |
| 1.125 … 1.3 | 5:4 (1.25) | 1350×1080 |
| 0.889 … 1.125 | 1:1 | 1080×1080 |
| 0.77 … 0.889 | 4:5 (0.8) | 1080×1350 |
| 0.643 … 0.77 | 3:4 (0.75) | 1080×1440, 3000×4000 photos |
| < 0.643 | 9:16 (0.5625) | 1080×1920, 720×1280 |

Boundaries are the midpoints between adjacent ratio values; ties go to the more common ratio (16:9, 9:16, 1:1). Custom ratios are never auto-picked. Audio-only and animated-image first inserts do not set the ratio (the next video/image does). The pick is recorded as an Edit Intent (`category: 'layout'`, `source: 'system'`) so it is visible and undoable; later inserts never change the ratio.

## 9. Failure cases

| Code | Trigger | Creator-facing message (EN; ID variant in ERROR_CATALOGUE.md) | Recovery | Stage |
|---|---|---|---|---|
| `EM-1001` | extension/container/codec not in §1; 0 streams; DRM; dimensions outside limits | "This file type is not supported (`<ext>` / `<codec>`). Supported: MP4, MOV, MKV, WebM, PNG, JPG, WebP, GIF, AVIF, MP3, WAV, AAC, M4A, OGG, FLAC." | convert elsewhere; import another file | 1–2 |
| `EM-1002` | file > 4 GB | "This file is larger than 4 GB." | trim or compress first | 1 |
| `EM-1003` | duration > 30 min | "This clip is longer than 30 minutes." | trim first | 2 |
| `EM-1004` | ffprobe failed / corrupt | "The file could not be read. It may be damaged or incomplete." | re-export the file | 2 |
| `EM-1005` | transcode/proxy/thumbnail/waveform process failed or interrupted | "Could not convert this file for editing." | Retry (re-runs from step 3 using the kept original) | 4–7 |
| `EM-1006` | ENOSPC during copy or transcode | "Not enough disk space to import (needs about <n> MB free)." | free space; Retry | 1, 4–5 |
| `EM-1007` (proposed) | > 200 assets in the Project | "This project already has 200 assets." | remove unused assets | 0 |
| `EM-1008` (proposed) | image > 8 192 px | "This image is larger than 8192 px on one side." | resize first | 2 |
| `EM-1009` (proposed) | cancelled by the Creator | (no error; toast "Import cancelled") | — | any |
| `EM-1010` (proposed) | source file disappeared during copy (drive removed) | "The file was removed before the import finished." | re-import | 1 |
| `EM-1301` | an Asset referenced by the Composition Model has missing files at preflight/Player load | "A clip's media file is missing (<name>)." | re-import (same hash relinks automatically) or remove the Clip | render preflight (PERFORMANCE.md §7), Player |

Every failure leaves the Asset card in `lib.assets.card.state.unsupported` (1001–1004, 1007–1008) or an error state with Retry (1005, 1006, 1010), and a `lib.assets.error` banner if several fail at once. No failure can crash the Local Service; FFmpeg exit codes and stderr go to `logs\service.log` with the Creator's paths redacted.

## 10. Privacy

| Aspect | Decision |
|---|---|
| Upload | none; ingestion is entirely local (ARCHITECTURE.md §2) |
| EXIF/metadata in copies | **Originals are byte-identical** (the sha256 must match the source for dedupe and integrity), so EXIF/GPS remains inside `original.<ext>` on the Creator's own disk. **Every derived file** (`playable.*`, `proxy.*`, `thumb.jpg`, `strip.jpg`) is written with `-map_metadata -1` (FFmpeg) or without `withMetadata()` (`sharp`), so it carries no EXIF, GPS, camera or creation-time tags. The Engine reads only derived files or decodes pixels/samples from the original, so **rendered Outputs never contain source metadata** (verified by QA-ING-012). |
| Metadata shown | `lib.assets.card.meta` shows technical fields only (§7); GPS, camera model and creation time are never displayed or indexed (they remain in `probe.json` for Diagnostics, which the Creator shares voluntarily) |
| Backup zips | include originals (with their EXIF); the Backup dialog says so |
| Logs | file paths are redacted to `<assetId>/original.<ext>`; original file names appear only in the database |

## 11. Tests to add (placeholders for TEST_PLAN.md)

| ID (proposed) | Check |
|---|---|
| QA-ING-001 | Each accepted container/codec in §1 imports to `ready` (fixture set: H.264 MP4, HEVC MOV 10-bit, VP9 WebM alpha, AV1 MKV, ProRes 422 MOV, PNG, JPG with EXIF orientation 6 and GPS, WebP, animated GIF, animated WebP, AVIF, MP3, WAV 24-bit, AAC, M4A, OGG Opus, FLAC) |
| QA-ING-002 | Unsupported fixtures (`.txt` renamed `.mp4`, `.svg`, `.braw`, 0-byte file, truncated MP4) → correct `EM-1001`/`EM-1004`, card in unsupported state, service alive |
| QA-ING-003 | Limits: 4.1 GB file → `EM-1002`; 31-minute audio → `EM-1003`; 9000×9000 PNG → `EM-1008`; 201st asset → `EM-1007` |
| QA-ING-004 | Decide-transcode rule: H.264 yuv420p AAC faststart MP4 → no `playable.mp4` (remux-free); same without faststart → remux only (`-c copy`); HEVC → full transcode |
| QA-ING-005 | VFR screen recording → playable copy is CFR; a Clip trimmed at 10 000 ms shows the same frame in Player and `renderStill` |
| QA-ING-006 | HDR PQ clip → SDR playable copy with `color_transfer=bt709`; no clipped highlights in a golden frame |
| QA-ING-007 | Rotated phone clip (rotation −90) → `AssetMeta` 1080×1920, Auto picks 9:16, playable copy has no rotation side data |
| QA-ING-008 | Auto ratio table §8 for 12 sample dimensions including 1440×900 (→ 16:9) and 3000×4000 (→ 3:4) |
| QA-ING-009 | Dedupe: importing the same file twice → one Asset, `asset.duplicate` event, no error |
| QA-ING-010 | Cancel during transcode → process tree gone within 2 s, folder removed, `asset.removed` emitted |
| QA-ING-011 | Disk-full simulation (quota) during transcode → `EM-1006`, original kept, Retry succeeds after space is freed |
| QA-ING-012 | Privacy: `exiftool`/ffprobe on `playable.mp4`, `proxy.jpg`, `thumb.jpg` and on a rendered Output show no GPS/camera/creation tags; `original.<ext>` hash equals the source file's |
| QA-ING-013 | Waveform: `wave.json` has `lengthMs` within 1 % of probe duration and `peaks.length == round(lengthMs / 10)`; silence region decodes to peaks ≤ 2 |
| QA-ING-014 | Budget: 1-minute 1080p30 H.264 clip (no transcode) → `ready` in ≤ 20 s on the reference T0 laptop (PERFORMANCE.md §5) |
| QA-ING-015 | Concurrency: 5 files dropped at once → at most 2 FFmpeg processes alive; all 5 reach `ready`; order of `asset.ready` events irrelevant to Sequence Badges |
| QA-ING-016 | Service kill mid-ingest → on restart the job is re-queued from step 3 when `original` + `probe.json` exist, otherwise marked failed and swept |
| QA-ING-017 | `EM-1301`: delete an asset folder by hand → preflight blocks render with the Clip name; re-importing the same file relinks (same sha256) |
