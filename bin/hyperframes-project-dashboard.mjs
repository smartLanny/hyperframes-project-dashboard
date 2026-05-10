#!/usr/bin/env node
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const isWindows = process.platform === "win32";
const isMac = process.platform === "darwin";
const defaultRootDir = process.env.HYPERFRAMES_INDEX_ROOT || process.env.HYPERFRAMES_DASHBOARD_ROOT || process.cwd();
const configDir = path.join(os.homedir(), ".hyperframes-project-dashboard");
const configPath = path.join(configDir, "config.json");
const deletedPath = path.join(configDir, "deleted.json");
const thumbnailCacheDir = path.join(configDir, "thumbnails");
const renderJobLogLimit = 12000;
const preferredPort = Number(
  process.env.HYPERFRAMES_INDEX_PORT ||
    process.argv.find((arg) => arg.startsWith("--port="))?.split("=")[1] ||
    4599
);
let rootDir = path.resolve(defaultRootDir);
const renderJobs = new Map();

const defaultRenderSettings = {
  format: "mp4",
  codec: "hevc",
  quality: "standard",
  fps: "30",
  workers: "auto",
  resolution: "",
  crf: "",
  videoBitrate: "",
  gpu: false,
  browserGpu: "auto",
  strict: false,
  strictAll: false,
};

const ignoredDirs = new Set([
  ".git",
  ".hyperframes",
  "assets",
  "compositions",
  "docs",
  "mockups",
  "node_modules",
  "renders",
  "scripts",
  "skills",
]);

const imageTypes = new Map([
  [".apng", "image/apng"],
  [".avif", "image/avif"],
  [".gif", "image/gif"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".webp", "image/webp"],
]);
const imageExtensions = new Set(imageTypes.keys());
const videoExtensions = new Set([".mp4", ".webm", ".mov", ".m4v"]);

function run(command, args, cwd, options = {}) {
  return new Promise((resolve) => {
    execFile(commandForPlatform(command), args, { cwd, maxBuffer: 1024 * 1024 * 8, windowsHide: true, ...options }, (error, stdout, stderr) => {
      resolve({ error, stdout, stderr });
    });
  });
}

function commandForPlatform(command) {
  if (isWindows && (command === "npx" || command === "npm")) {
    return `${command}.cmd`;
  }
  return command;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function powerShellSingleQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function cliRootArg() {
  const withEquals = process.argv.find((arg) => arg.startsWith("--root="));
  if (withEquals) return withEquals.split("=").slice(1).join("=");

  const rootFlagIndex = process.argv.indexOf("--root");
  if (rootFlagIndex >= 0 && process.argv[rootFlagIndex + 1]) {
    return process.argv[rootFlagIndex + 1];
  }

  return process.argv.slice(2).find((arg) => !arg.startsWith("--"));
}

async function readJsonFile(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJsonFile(filePath, data) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

async function loadInitialRootDir() {
  const explicitRoot = cliRootArg();
  if (explicitRoot) return path.resolve(explicitRoot);

  const config = await readJsonFile(configPath, {});
  if (config.rootDir) return path.resolve(config.rootDir);

  return path.resolve(defaultRootDir);
}

async function saveRootDir(nextRootDir) {
  const config = await readJsonFile(configPath, {});
  await writeJsonFile(configPath, {
    ...config,
    rootDir: path.resolve(nextRootDir),
    updatedAt: new Date().toISOString(),
  });
}

function normalizeRenderSettings(input = {}) {
  const settings = { ...defaultRenderSettings, ...(input || {}) };
  const formats = new Set(["mp4", "webm", "mov"]);
  const codecs = new Set(["hevc", "native"]);
  const qualities = new Set(["draft", "standard", "high"]);
  const fpsValues = new Set(["24", "30", "60"]);
  const resolutions = new Set(["", "landscape", "portrait", "landscape-4k", "portrait-4k"]);
  const browserGpuValues = new Set(["auto", "on", "off"]);

  settings.format = formats.has(settings.format) ? settings.format : defaultRenderSettings.format;
  settings.codec = codecs.has(settings.codec) ? settings.codec : defaultRenderSettings.codec;
  if (settings.format === "webm") settings.codec = "native";
  settings.quality = qualities.has(settings.quality) ? settings.quality : defaultRenderSettings.quality;
  settings.fps = fpsValues.has(String(settings.fps)) ? String(settings.fps) : defaultRenderSettings.fps;
  settings.workers = settings.workers ? String(settings.workers).trim() : defaultRenderSettings.workers;
  settings.resolution = resolutions.has(settings.resolution) ? settings.resolution : "";
  settings.crf = settings.crf === "" || settings.crf == null ? "" : String(settings.crf).trim();
  settings.videoBitrate = settings.videoBitrate === "" || settings.videoBitrate == null ? "" : String(settings.videoBitrate).trim();
  settings.gpu = Boolean(settings.gpu);
  settings.browserGpu = browserGpuValues.has(settings.browserGpu) ? settings.browserGpu : "auto";
  settings.strict = Boolean(settings.strict);
  settings.strictAll = Boolean(settings.strictAll);

  if (settings.crf && settings.videoBitrate) {
    settings.videoBitrate = "";
  }

  return settings;
}

async function loadRenderSettings() {
  const config = await readJsonFile(configPath, {});
  return normalizeRenderSettings(config.renderSettings || {});
}

async function saveRenderSettings(nextSettings) {
  const config = await readJsonFile(configPath, {});
  const renderSettings = normalizeRenderSettings(nextSettings);
  await writeJsonFile(configPath, {
    ...config,
    renderSettings,
    updatedAt: new Date().toISOString(),
  });
  return renderSettings;
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function safeStat(filePath) {
  try {
    return await fs.stat(filePath);
  } catch {
    return null;
  }
}

async function listDirs(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .filter((entry) => !entry.name.startsWith("."))
    .filter((entry) => !ignoredDirs.has(entry.name))
    .map((entry) => path.join(dir, entry.name));
}

async function projectDirsForRoot(dir) {
  const resolvedDir = path.resolve(dir);
  const candidateDirs = [resolvedDir, ...(await listDirs(resolvedDir))];
  const result = [];

  for (const projectDir of candidateDirs) {
    if (await exists(path.join(projectDir, "index.html"))) {
      result.push(projectDir);
    }
  }

  return result;
}

function projectIdForDir(projectDir) {
  return path.resolve(projectDir) === path.resolve(rootDir) ? path.basename(rootDir) : path.basename(projectDir);
}

async function resolveProjectDir(id) {
  const projectDirs = await projectDirsForRoot(rootDir);
  const projectDir = projectDirs.find((candidate) => projectIdForDir(candidate) === id);
  if (!projectDir) {
    throw new Error(`Unknown project: ${id}`);
  }

  const resolvedDir = path.resolve(projectDir);
  if (resolvedDir !== rootDir && !resolvedDir.startsWith(rootDir + path.sep)) {
    throw new Error("Project is outside the index root");
  }

  return resolvedDir;
}

async function validateRootDir(dir) {
  const resolvedDir = path.resolve(dir);
  const stat = await safeStat(resolvedDir);
  if (!stat?.isDirectory()) {
    throw new Error(`Folder does not exist: ${resolvedDir}`);
  }

  const childProjectDirs = [];
  for (const childDir of await listDirs(resolvedDir)) {
    if (await exists(path.join(childDir, "index.html"))) {
      childProjectDirs.push(childDir);
    }
  }

  if (!childProjectDirs.length) {
    throw new Error("Choose a parent folder with at least one HyperFrames project subfolder.");
  }

  return resolvedDir;
}

function readAttr(tag, attr) {
  const match = tag.match(new RegExp(`${attr}=["']([^"']+)["']`));
  return match?.[1] || null;
}

async function readProjectMeta(projectDir) {
  const indexPath = path.join(projectDir, "index.html");
  const html = await fs.readFile(indexPath, "utf8");
  const firstCompositionTag = html.match(/<[^>]+data-composition-id=["'][^"']+["'][^>]*>/s)?.[0] || "";
  const packagePath = path.join(projectDir, "package.json");
  let packageName = null;

  if (await exists(packagePath)) {
    try {
      packageName = JSON.parse(await fs.readFile(packagePath, "utf8")).name || null;
    } catch {
      packageName = null;
    }
  }

  const compositionCount = Array.from(html.matchAll(/data-composition-id=/g)).length;
  const mediaCount = Array.from(html.matchAll(/<(video|audio)\b/g)).length;
  const width = readAttr(firstCompositionTag, "data-width");
  const height = readAttr(firstCompositionTag, "data-height");
  const durationRaw = readAttr(firstCompositionTag, "data-duration");
  const duration = durationRaw ? Number(durationRaw) : null;
  const id = projectIdForDir(projectDir);

  return {
    id,
    title: packageName || id,
    dir: projectDir,
    indexPath,
    compositionId: readAttr(firstCompositionTag, "data-composition-id"),
    compositionCount,
    mediaCount,
    size: width && height ? `${width}x${height}` : null,
    duration,
    modifiedAt: (await safeStat(indexPath))?.mtime?.toISOString() || null,
  };
}

function thumbnailCacheKey(projectDir) {
  return createHash("sha1").update(path.resolve(projectDir)).digest("hex").slice(0, 16);
}

async function cachedThumbnailPath(projectDir) {
  const key = thumbnailCacheKey(projectDir);
  if (!(await exists(thumbnailCacheDir))) return null;

  const entries = await fs.readdir(thumbnailCacheDir, { withFileTypes: true });
  const matches = entries
    .filter((entry) => entry.isFile())
    .filter((entry) => entry.name.startsWith(`${key}-`))
    .filter((entry) => imageTypes.has(path.extname(entry.name).toLowerCase()))
    .map((entry) => path.join(thumbnailCacheDir, entry.name));
  const withStats = await Promise.all(matches.map(async (file) => ({ file, stat: await safeStat(file) })));
  withStats.sort((a, b) => (b.stat?.mtimeMs || 0) - (a.stat?.mtimeMs || 0));
  return withStats[0]?.file || null;
}

async function cacheThumbnail(projectDir, sourcePath) {
  const ext = path.extname(sourcePath).toLowerCase() || ".png";
  const key = thumbnailCacheKey(projectDir);
  const target = path.join(thumbnailCacheDir, `${key}-${path.basename(projectDir)}${ext}`);
  const [sourceStat, targetStat] = await Promise.all([safeStat(sourcePath), safeStat(target)]);
  if (!sourceStat) return null;

  if (targetStat && targetStat.mtimeMs >= sourceStat.mtimeMs && targetStat.size === sourceStat.size) {
    return target;
  }

  await fs.mkdir(thumbnailCacheDir, { recursive: true });
  await fs.copyFile(sourcePath, target);
  return target;
}

async function collectMediaFiles(dir, extensions, depth = 2) {
  const stat = await safeStat(dir);
  if (!stat?.isDirectory()) return [];

  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory() && depth > 0) {
      files.push(...(await collectMediaFiles(fullPath, extensions, depth - 1)));
    } else if (entry.isFile() && extensions.has(path.extname(entry.name).toLowerCase())) {
      files.push(fullPath);
    }
  }
  return files;
}

async function latestFileByMtime(files) {
  const withStats = await Promise.all(files.map(async (file) => ({ file, stat: await safeStat(file) })));
  withStats.sort((a, b) => (b.stat?.mtimeMs || 0) - (a.stat?.mtimeMs || 0));
  return withStats[0]?.file || null;
}

async function findLatestMediaFile(projectDir, folders, extensions, depth = 2) {
  const files = [];
  for (const folder of folders) {
    files.push(...(await collectMediaFiles(path.join(projectDir, folder), extensions, depth)));
  }
  return latestFileByMtime(files);
}

async function findSourceThumbnail(projectDir) {
  const candidates = [
    "side-preview-contact-sheet.png",
    "review-contact-sheet.png",
    "contact-sheet.png",
    "snapshots/contact-sheet.png",
  ];

  for (const candidate of candidates) {
    const fullPath = path.join(projectDir, candidate);
    if (await exists(fullPath)) return fullPath;
  }

  const snapshotDir = path.join(projectDir, "snapshots");
  if (await exists(snapshotDir)) {
    const images = (await fs.readdir(snapshotDir, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && imageExtensions.has(path.extname(entry.name).toLowerCase()))
      .map((entry) => path.join(snapshotDir, entry.name));
    const latestSnapshot = await latestFileByMtime(images);
    if (latestSnapshot) return latestSnapshot;
  }

  return findLatestMediaFile(projectDir, ["renders/qa", "renders"], imageExtensions, 2);
}

async function findThumbnail(projectDir) {
  const sourceThumbnail = await findSourceThumbnail(projectDir);
  if (sourceThumbnail) {
    return (await cacheThumbnail(projectDir, sourceThumbnail)) || sourceThumbnail;
  }

  return cachedThumbnailPath(projectDir);
}

async function refreshThumbnailCache() {
  const projectDirs = await projectDirsForRoot(rootDir);
  const results = await Promise.all(projectDirs.map(async (projectDir) => {
    const thumbnail = await findSourceThumbnail(projectDir);
    if (!thumbnail) return false;
    await cacheThumbnail(projectDir, thumbnail);
    return true;
  }));
  return results.filter(Boolean).length;
}

async function findLatestRender(projectDir) {
  return findLatestMediaFile(projectDir, ["renders"], videoExtensions, 3);
}

function safeFileNamePart(value) {
  return String(value || "project")
    .replace(/[^a-z0-9._-]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120) || "project";
}

function renderStamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
}

function renderJobSummary(job) {
  return {
    id: job.id,
    project: job.project,
    status: job.status,
    phase: job.phase,
    settings: job.settings,
    outputPath: job.outputPath,
    outputName: job.outputPath ? path.basename(job.outputPath) : null,
    error: job.error,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    log: job.log.slice(-4000),
  };
}

function renderJobSummaries() {
  return Array.from(renderJobs.values())
    .sort((a, b) => Date.parse(b.startedAt || "") - Date.parse(a.startedAt || ""))
    .map(renderJobSummary);
}

function latestRenderJobForProject(projectId) {
  return renderJobSummaries().find((job) => job.project === projectId) || null;
}

function appendRenderLog(job, chunk) {
  const text = String(chunk || "");
  if (!text) return;
  job.log = `${job.log}${text}`.slice(-renderJobLogLimit);
}

function runRenderProcess(command, args, cwd, job, phase) {
  job.phase = phase;
  appendRenderLog(job, `\n$ ${command} ${args.join(" ")}\n`);

  return new Promise((resolve, reject) => {
    const child = spawn(commandForPlatform(command), args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    job.pid = child.pid;

    child.stdout.on("data", (chunk) => appendRenderLog(job, chunk));
    child.stderr.on("data", (chunk) => appendRenderLog(job, chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      job.pid = null;
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${phase} failed with exit code ${code}`));
    });
  });
}

function hyperframesRenderArgs(outputPath, settings) {
  const args = [
    "hyperframes",
    "render",
    "--output",
    outputPath,
    "--format",
    settings.format === "mov" ? "mov" : settings.format === "webm" ? "webm" : "mp4",
    "--quality",
    settings.quality,
    "--fps",
    settings.fps,
  ];

  if (settings.workers) args.push("--workers", settings.workers);
  if (settings.resolution) args.push("--resolution", settings.resolution);
  if (settings.crf && settings.codec !== "hevc") args.push("--crf", settings.crf);
  if (settings.videoBitrate && settings.codec !== "hevc") args.push("--video-bitrate", settings.videoBitrate);
  if (settings.gpu) args.push("--gpu");
  if (settings.browserGpu === "on") args.push("--browser-gpu");
  if (settings.browserGpu === "off") args.push("--no-browser-gpu");
  if (settings.strictAll) args.push("--strict-all");
  else if (settings.strict) args.push("--strict");

  return args;
}

async function transcodeToHevc(inputPath, outputPath, projectDir, job, settings) {
  const commonArgs = [
    "-y",
    "-hide_banner",
    "-i",
    inputPath,
    "-map",
    "0",
    "-tag:v",
    "hvc1",
    "-pix_fmt",
    "yuv420p",
  ];

  const videotoolboxArgs = [
    ...commonArgs,
    "-c:v",
    "hevc_videotoolbox",
    "-b:v",
    settings.videoBitrate || "12M",
    "-c:a",
    "copy",
    outputPath,
  ];

  try {
    await runRenderProcess("ffmpeg", videotoolboxArgs, projectDir, job, "transcoding HEVC");
    return;
  } catch (error) {
    appendRenderLog(job, `\nhevc_videotoolbox failed, falling back to libx265: ${error.message}\n`);
  }

  const libx265Args = [
    ...commonArgs,
    "-c:v",
    "libx265",
    "-crf",
    settings.crf || "24",
    "-preset",
    "medium",
    "-c:a",
    "copy",
    outputPath,
  ];
  await runRenderProcess("ffmpeg", libx265Args, projectDir, job, "transcoding HEVC");
}

async function runRenderJob(job) {
  try {
    job.status = "running";
    await fs.mkdir(path.dirname(job.outputPath), { recursive: true });

    const needsHevcTranscode = job.settings.codec === "hevc" && job.settings.format !== "webm";
    const hyperOutput = needsHevcTranscode
      ? path.join(path.dirname(job.outputPath), `.${job.id}-native.mp4`)
      : job.outputPath;

    await runRenderProcess(
      "npx",
      hyperframesRenderArgs(hyperOutput, { ...job.settings, format: needsHevcTranscode ? "mp4" : job.settings.format }),
      job.projectDir,
      job,
      "rendering"
    );

    if (needsHevcTranscode) {
      await transcodeToHevc(hyperOutput, job.outputPath, job.projectDir, job, job.settings);
      await fs.rm(hyperOutput, { force: true });
    }

    job.status = "completed";
    job.phase = "completed";
    job.completedAt = new Date().toISOString();

    if (await exists(job.outputPath)) {
      await generateSnapshotFromRender(job.projectDir, job.outputPath).catch((error) => {
        appendRenderLog(job, `\nSnapshot update failed: ${error.message}\n`);
      });
    }
  } catch (error) {
    job.status = "failed";
    job.phase = "failed";
    job.error = error.message;
    job.completedAt = new Date().toISOString();
    appendRenderLog(job, `\n${error.stack || error.message}\n`);
  }
}

async function startRenderJob(id, overrides = {}) {
  const projectDir = await resolveProjectDir(id);
  const baseSettings = await loadRenderSettings();
  const settings = normalizeRenderSettings({ ...baseSettings, ...(overrides || {}) });
  const extension = settings.format === "webm" ? "webm" : settings.format === "mov" ? "mov" : "mp4";
  const codecSuffix = settings.codec === "hevc" && settings.format !== "webm" ? "hevc" : "native";
  const outputPath = path.join(
    projectDir,
    "renders",
    `${safeFileNamePart(id)}_${renderStamp()}_${settings.quality}_${codecSuffix}.${extension}`
  );
  const job = {
    id: `${safeFileNamePart(id)}-${Date.now()}`,
    project: id,
    projectDir,
    settings,
    status: "queued",
    phase: "queued",
    outputPath,
    error: null,
    log: "",
    startedAt: new Date().toISOString(),
    completedAt: null,
    pid: null,
  };

  renderJobs.set(job.id, job);
  runRenderJob(job);
  return renderJobSummary(job);
}

async function generateSnapshotFromRender(projectDir, renderPath) {
  const key = thumbnailCacheKey(projectDir);
  const target = path.join(thumbnailCacheDir, `${key}-${path.basename(projectDir)}-generated.jpg`);
  await fs.mkdir(thumbnailCacheDir, { recursive: true });

  const baseArgs = [
    "-y",
    "-loglevel",
    "error",
    "-i",
    renderPath,
    "-frames:v",
    "1",
    "-vf",
    "scale=960:-2",
    target,
  ];
  let result = await run("ffmpeg", ["-ss", "1", ...baseArgs], projectDir, { timeout: 45000 });
  if (result.error || !(await exists(target))) {
    result = await run("ffmpeg", baseArgs, projectDir, { timeout: 45000 });
  }
  if (result.error || !(await exists(target))) {
    throw new Error(result.stderr.trim() || "Failed to generate snapshot from render.");
  }

  return target;
}

async function generateSnapshotWithHyperframes(projectDir) {
  const result = await run(
    "npx",
    ["hyperframes", "snapshot", "--frames=1", "--timeout=10000"],
    projectDir,
    { timeout: 45000 }
  );
  if (result.error) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || "HyperFrames snapshot failed.");
  }

  const sourceThumbnail = await latestFileByMtime(await collectMediaFiles(path.join(projectDir, "snapshots"), imageExtensions, 2));
  if (!sourceThumbnail) {
    throw new Error("HyperFrames snapshot finished, but no snapshot image was found.");
  }

  return (await cacheThumbnail(projectDir, sourceThumbnail)) || sourceThumbnail;
}

async function generateProjectSnapshot(id, options = {}) {
  const projectDir = await resolveProjectDir(id);
  const latestRender = await findLatestRender(projectDir);

  if (options.force && latestRender) {
    const generated = await generateSnapshotFromRender(projectDir, latestRender);
    return {
      status: "generated",
      project: id,
      source: latestRender,
      thumbnailPath: generated,
      thumbnailUrl: `/file?path=${encodeURIComponent(generated)}`,
    };
  }

  if (options.force) {
    const generated = await generateSnapshotWithHyperframes(projectDir);
    return {
      status: "generated",
      project: id,
      source: "hyperframes snapshot",
      thumbnailPath: generated,
      thumbnailUrl: `/file?path=${encodeURIComponent(generated)}`,
    };
  }

  const sourceThumbnail = await findSourceThumbnail(projectDir);
  if (sourceThumbnail) {
    const cached = await cacheThumbnail(projectDir, sourceThumbnail);
    return {
      status: "generated",
      project: id,
      source: sourceThumbnail,
      thumbnailPath: cached || sourceThumbnail,
      thumbnailUrl: `/file?path=${encodeURIComponent(cached || sourceThumbnail)}`,
    };
  }

  if (latestRender) {
    const generated = await generateSnapshotFromRender(projectDir, latestRender);
    return {
      status: "generated",
      project: id,
      source: latestRender,
      thumbnailPath: generated,
      thumbnailUrl: `/file?path=${encodeURIComponent(generated)}`,
    };
  }

  const generated = await generateSnapshotWithHyperframes(projectDir);
  return {
    status: "generated",
    project: id,
    source: "hyperframes snapshot",
    thumbnailPath: generated,
    thumbnailUrl: `/file?path=${encodeURIComponent(generated)}`,
  };
}

function parsePreviewServers(output) {
  return output
    .split("\n")
    .map((line) => line.match(/Port\s+(\d+)\s+(\S+)\s+(.+?)\s+\(PID\s+(\d+)\)/))
    .filter(Boolean)
    .map((match) => ({
      port: Number(match[1]),
      project: match[2],
      dir: path.resolve(match[3].trim()),
      pid: Number(match[4]),
    }));
}

function uniqueServers(servers) {
  const byKey = new Map();
  for (const server of servers) {
    byKey.set(`${server.port}:${server.dir}`, server);
  }
  return Array.from(byKey.values()).sort((a, b) => a.port - b.port);
}

async function listeningPids(port) {
  if (isWindows) {
    const ps = `Get-NetTCPConnection -LocalPort ${Number(port)} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess`;
    const result = await run("powershell.exe", ["-NoProfile", "-Command", ps], rootDir, { timeout: 3000 });
    if (!result.error) {
      return result.stdout
        .split(/\s+/)
        .map((value) => Number(value))
        .filter(Number.isInteger);
    }
    return [];
  }

  const result = await run("lsof", [`-tiTCP:${port}`, "-sTCP:LISTEN"], rootDir, { timeout: 2000 });
  return result.stdout
    .split(/\s+/)
    .map((value) => Number(value))
    .filter(Number.isInteger);
}

async function probePreviewPort(port) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 350);

  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/projects`, {
      signal: controller.signal,
      cache: "no-store",
    });
    if (!response.ok) return [];
    const data = await response.json();
    return (data.projects || []).map((project) => ({
      port,
      project: project.id,
      dir: path.resolve(project.dir),
      pid: null,
    }));
  } catch {
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

async function probePreviewServers() {
  const ports = [
    ...Array.from({ length: 49 }, (_, index) => 3002 + index),
    ...Array.from({ length: 14 }, (_, index) => 4567 + index),
  ];
  const results = await Promise.all(ports.map((port) => probePreviewPort(port)));
  return results.flat();
}

async function activePreviewServers() {
  const result = await run("npx", ["hyperframes", "preview", "--list"], rootDir, { timeout: 6000 });
  const listed = result.error ? [] : parsePreviewServers(result.stdout);
  const probed = await probePreviewServers();
  return uniqueServers([...listed, ...probed]);
}

async function serversForProjectDir(projectDir) {
  const resolvedDir = path.resolve(projectDir);
  return (await activePreviewServers()).filter((server) => server.dir === resolvedDir);
}

async function waitForProjectServers(projectDir, timeoutMs = 9000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const servers = await serversForProjectDir(projectDir);
    if (servers.length) return servers;
    await wait(650);
  }
  return [];
}

async function resolveProject(id) {
  const projectDir = await resolveProjectDir(id);
  const meta = await readProjectMeta(projectDir);
  const activeServers = await serversForProjectDir(projectDir);
  const latestRender = await findLatestRender(projectDir);
  return {
    ...meta,
    activeServers,
    studioUrls: studioUrlsForServers(activeServers),
    latestRender: latestRender ? path.relative(projectDir, latestRender) : null,
    latestRenderPath: latestRender,
  };
}

function studioUrlsForServers(servers) {
  return servers.map((server) => `http://localhost:${server.port}/#project/${server.project}`);
}

async function startProject(id) {
  const project = await resolveProject(id);
  if (project.activeServers.length > 0) {
    return {
      status: "already-running",
      project: project.id,
      ports: project.activeServers.map((server) => server.port),
      studioUrls: studioUrlsForServers(project.activeServers),
    };
  }

  const child = spawn(commandForPlatform("npx"), ["hyperframes", "preview"], {
    cwd: project.dir,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();

  const servers = await waitForProjectServers(project.dir, 3500);

  return {
    status: servers.length ? "running" : "starting",
    project: project.id,
    pid: child.pid,
    ports: servers.map((server) => server.port),
    studioUrls: studioUrlsForServers(servers),
  };
}

async function stopServer(server) {
  const pids = new Set();
  if (Number.isInteger(server.pid)) pids.add(server.pid);

  for (const pid of await listeningPids(server.port)) {
    pids.add(pid);
  }

  const killablePids = Array.from(pids).filter((pid) => (
    Number.isInteger(pid) &&
    pid > 0 &&
    pid !== process.pid &&
    pid !== process.ppid
  ));

  for (const pid of killablePids) {
    try {
      await terminateProcess(pid, false);
    } catch {
      // Process may already be gone.
    }
  }

  await wait(650);

  for (const pid of killablePids) {
    try {
      if (processIsAlive(pid)) {
        await terminateProcess(pid, true);
      }
    } catch {
      // Process exited cleanly.
    }
  }

  return { port: server.port, pids: killablePids };
}

async function terminateProcess(pid, force = false) {
  if (isWindows) {
    const args = ["/PID", String(pid), "/T"];
    if (force) args.unshift("/F");
    await run("taskkill.exe", args, rootDir, { timeout: 5000 });
    return;
  }

  process.kill(pid, force ? "SIGKILL" : "SIGTERM");
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function stopProject(id) {
  const projectDir = await resolveProjectDir(id);
  const activeServers = await serversForProjectDir(projectDir);
  const stopped = [];
  for (const server of activeServers) {
    stopped.push(await stopServer(server));
  }

  return {
    status: stopped.length ? "stopped" : "not-running",
    project: id,
    stopped,
  };
}

async function stopAllProjects() {
  const projectDirs = await projectDirsForRoot(rootDir);
  const projectDirSet = new Set(projectDirs.map((projectDir) => path.resolve(projectDir)));
  const activeServers = (await activePreviewServers())
    .filter((server) => projectDirSet.has(path.resolve(server.dir)));
  const stopped = [];

  for (const server of activeServers) {
    stopped.push(await stopServer(server));
  }

  return {
    status: stopped.length ? "stopped" : "not-running",
    stopped,
    count: stopped.length,
  };
}

async function deletedRecords() {
  const records = await readJsonFile(deletedPath, []);
  return Array.isArray(records) ? records : [];
}

async function recordDeletedProject(record) {
  const records = await deletedRecords();
  records.unshift(record);
  await writeJsonFile(deletedPath, records.slice(0, 100));
}

function trashDestination(projectId) {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
  if (isMac) return path.join(os.homedir(), ".Trash", `${projectId}-${stamp}`);
  if (isWindows) return `Recycle Bin/${projectId}-${stamp}`;
  return path.join(os.homedir(), ".local", "share", "Trash", "files", `${projectId}-${stamp}`);
}

async function moveProjectToTrash(projectDir, projectId) {
  const destination = trashDestination(projectId);

  if (isWindows) {
    const script = [
      "Add-Type -AssemblyName Microsoft.VisualBasic;",
      `[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory(${powerShellSingleQuote(projectDir)}, 'OnlyErrorDialogs', 'SendToRecycleBin')`,
    ].join(" ");
    const result = await run("powershell.exe", ["-NoProfile", "-Command", script], rootDir, { timeout: 120000 });
    if (!result.error) return destination;

    const fallback = path.join(configDir, "trash", `${projectId}-${Date.now()}`);
    await fs.mkdir(path.dirname(fallback), { recursive: true });
    await fs.rename(projectDir, fallback);
    return fallback;
  }

  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.rename(projectDir, destination);
  return destination;
}

async function deleteProject(id, confirmName) {
  const project = await resolveProject(id);
  if (confirmName !== project.id) {
    throw new Error("Project name confirmation did not match.");
  }

  if (path.resolve(project.dir) === path.resolve(rootDir)) {
    throw new Error("Refusing to delete the selected root folder project.");
  }

  const stopResult = await stopProject(id);
  const destination = await moveProjectToTrash(project.dir, project.id);

  const record = {
    id: project.id,
    from: project.dir,
    to: destination,
    deletedAt: new Date().toISOString(),
    stopped: stopResult.stopped,
  };
  await recordDeletedProject(record);

  return {
    status: "deleted",
    project: project.id,
    destination,
  };
}

async function deleteProjects(ids, confirmText) {
  const uniqueIds = Array.from(new Set(Array.isArray(ids) ? ids : []));
  if (!uniqueIds.length) {
    throw new Error("No projects selected.");
  }
  if (confirmText !== "DELETE") {
    throw new Error("Type DELETE to confirm bulk delete.");
  }

  const results = [];
  for (const id of uniqueIds) {
    try {
      results.push(await deleteProject(id, id));
    } catch (error) {
      results.push({ status: "error", project: id, error: error.message });
    }
  }

  return {
    status: results.some((result) => result.status === "error") ? "partial" : "deleted",
    results,
  };
}

async function openProjectTarget(id, target) {
  const project = await resolveProject(id);
  let targetPath = project.dir;

  if (target === "render") {
    if (!project.latestRenderPath) {
      throw new Error("This project has no render to open.");
    }
    targetPath = project.latestRenderPath;
  } else if (target !== "folder") {
    throw new Error(`Unsupported open target: ${target}`);
  }

  const result = await openPath(targetPath);
  if (result.error) {
    throw new Error(result.stderr.trim() || `Failed to open ${targetPath}`);
  }

  return {
    status: "opened",
    project: project.id,
    target,
    path: targetPath,
  };
}

async function openPath(targetPath) {
  if (isMac) return run("open", [targetPath], rootDir);
  if (isWindows) return run("explorer.exe", [targetPath], rootDir);
  return run("xdg-open", [targetPath], rootDir);
}

async function chooseRootDir() {
  const result = await chooseFolderNative();
  if (result.error) {
    throw new Error(result.stderr.trim() || "Folder selection cancelled.");
  }

  const selected = result.stdout.trim();
  const nextRootDir = await validateRootDir(selected);
  rootDir = nextRootDir;
  await saveRootDir(rootDir);
  await refreshThumbnailCache();

  return scanProjects();
}

async function chooseFolderNative() {
  if (isMac) {
    const script = 'POSIX path of (choose folder with prompt "Choose a HyperFrames projects folder")';
    return run("osascript", ["-e", script], rootDir);
  }

  if (isWindows) {
    const script = [
      "Add-Type -AssemblyName System.Windows.Forms;",
      "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog;",
      "$dialog.Description = 'Choose a HyperFrames projects folder';",
      "$dialog.ShowNewFolderButton = $false;",
      "if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {",
      "  [Console]::Out.Write($dialog.SelectedPath)",
      "} else { exit 1 }",
    ].join(" ");
    return run("powershell.exe", ["-NoProfile", "-STA", "-Command", script], rootDir);
  }

  const zenity = await run("zenity", ["--file-selection", "--directory", "--title=Choose a HyperFrames projects folder"], rootDir);
  if (!zenity.error) return zenity;
  return run("kdialog", ["--getexistingdirectory", rootDir], rootDir);
}

async function scanProjects() {
  const withIndex = await projectDirsForRoot(rootDir);

  const servers = await activePreviewServers();
  const projects = await Promise.all(
    withIndex.map(async (projectDir) => {
      const meta = await readProjectMeta(projectDir);
      const activeServers = servers
        .filter((server) => server.dir === path.resolve(projectDir))
        .sort((a, b) => a.port - b.port);
      const thumbnail = await findThumbnail(projectDir);
      const latestRender = await findLatestRender(projectDir);
      return {
        ...meta,
        isRootProject: path.resolve(projectDir) === path.resolve(rootDir),
        canDelete: path.resolve(projectDir) !== path.resolve(rootDir),
        activeServers,
        studioUrls: studioUrlsForServers(activeServers),
        renderJob: latestRenderJobForProject(meta.id),
        thumbnailUrl: thumbnail ? `/file?path=${encodeURIComponent(thumbnail)}` : null,
        thumbnailPath: thumbnail,
        latestRender: latestRender ? path.relative(projectDir, latestRender) : null,
        latestRenderPath: latestRender,
        command: `cd ${JSON.stringify(projectDir)} && npx hyperframes preview`,
      };
    })
  );

  projects.sort((a, b) => {
    if (a.activeServers.length !== b.activeServers.length) return b.activeServers.length - a.activeServers.length;
    const aTime = Date.parse(a.modifiedAt || "") || 0;
    const bTime = Date.parse(b.modifiedAt || "") || 0;
    if (aTime !== bTime) return bTime - aTime;
    return a.id.localeCompare(b.id);
  });

  return {
    rootDir,
    generatedAt: new Date().toISOString(),
    renderSettings: await loadRenderSettings(),
    renderJobs: renderJobSummaries(),
    projects,
  };
}

function json(res, status, data) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(data, null, 2));
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function html(res) {
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>HyperFrames Project Index</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #101113;
      --panel: #191b1f;
      --panel-2: #202329;
      --line: #30343c;
      --text: #f3f1ea;
      --muted: #a8adb7;
      --accent: #ff5148;
      --ok: #65d18a;
      --warn: #e3b05d;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }

    * { box-sizing: border-box; }

    body {
      margin: 0;
      min-height: 100vh;
      background: var(--bg);
      color: var(--text);
    }

    header {
      position: sticky;
      top: 0;
      z-index: 5;
      border-bottom: 1px solid var(--line);
      background: rgba(16, 17, 19, 0.94);
      backdrop-filter: blur(16px);
    }

    .bar {
      display: grid;
      grid-template-columns: minmax(220px, 1fr) auto;
      gap: 18px;
      align-items: end;
      max-width: 1480px;
      margin: 0 auto;
      padding: 22px 28px;
    }

    h1 {
      margin: 0 0 6px;
      font-size: 24px;
      line-height: 1.1;
      letter-spacing: 0;
    }

    .root {
      margin: 0;
      color: var(--muted);
      font-size: 13px;
      overflow-wrap: anywhere;
    }

    .tools {
      display: grid;
      grid-template-columns: minmax(220px, 320px) minmax(160px, 200px) auto auto auto auto auto auto;
      gap: 10px;
      align-items: center;
    }

    input, select, button {
      height: 38px;
      border: 1px solid var(--line);
      border-radius: 7px;
      background: var(--panel);
      color: var(--text);
      font: inherit;
      font-size: 14px;
    }

    input, select {
      width: 100%;
      padding: 0 12px;
      outline: none;
    }

    button {
      padding: 0 14px;
      cursor: pointer;
    }

    button:hover, .button:hover {
      border-color: #6b7280;
      background: #252933;
    }

    button:disabled {
      cursor: not-allowed;
      opacity: 0.55;
    }

    main {
      max-width: 1480px;
      margin: 0 auto;
      padding: 22px 28px 48px;
    }

    .summary {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      margin-bottom: 18px;
      color: var(--muted);
      font-size: 13px;
    }

    .summary span {
      padding: 7px 10px;
      border: 1px solid var(--line);
      border-radius: 999px;
      background: #16181d;
    }

    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(310px, 1fr));
      gap: 16px;
    }

    .grid.list-view {
      display: flex;
      flex-direction: column;
      gap: 10px;
    }

    .card {
      position: relative;
      overflow: hidden;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--panel);
      min-width: 0;
    }

    .grid.list-view .card {
      display: grid;
      grid-template-columns: minmax(180px, 260px) minmax(0, 1fr);
      min-height: 170px;
    }

    .grid.list-view .thumb {
      height: 100%;
      min-height: 170px;
      aspect-ratio: auto;
      border-right: 1px solid var(--line);
      border-bottom: 0;
    }

    .grid.list-view .body {
      display: grid;
      grid-template-columns: minmax(0, 1fr);
      align-content: start;
    }

    .card-select {
      position: absolute;
      top: 10px;
      left: 10px;
      z-index: 2;
      display: inline-grid;
      place-items: center;
      width: 30px;
      height: 30px;
      border: 1px solid rgba(255, 255, 255, 0.24);
      border-radius: 7px;
      background: rgba(10, 11, 13, 0.72);
      backdrop-filter: blur(10px);
    }

    .card-select input {
      width: 16px;
      height: 16px;
      padding: 0;
      accent-color: var(--accent);
    }

    .thumb {
      display: grid;
      place-items: center;
      aspect-ratio: 16 / 9;
      background:
        radial-gradient(circle at 22% 24%, rgba(255, 81, 72, 0.22), transparent 32%),
        linear-gradient(145deg, #20242b, #121417);
      border-bottom: 1px solid var(--line);
      color: #7d8490;
      font-size: 13px;
      overflow: hidden;
    }

    .thumb img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
    }

    .body {
      padding: 14px;
    }

    .title-row {
      display: flex;
      gap: 10px;
      align-items: flex-start;
      justify-content: space-between;
      margin-bottom: 8px;
    }

    h2 {
      margin: 0;
      font-size: 17px;
      line-height: 1.25;
      letter-spacing: 0;
      overflow-wrap: anywhere;
    }

    .status {
      flex: 0 0 auto;
      border-radius: 999px;
      padding: 4px 8px;
      font-size: 12px;
      border: 1px solid var(--line);
      color: var(--muted);
    }

    .status.active {
      color: #0d1510;
      border-color: transparent;
      background: var(--ok);
    }

    .meta {
      display: flex;
      flex-wrap: wrap;
      gap: 7px;
      margin: 10px 0 12px;
    }

    .chip {
      padding: 5px 8px;
      border-radius: 6px;
      background: var(--panel-2);
      color: var(--muted);
      font-size: 12px;
    }

    .path, .command {
      margin: 0 0 12px;
      color: var(--muted);
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 12px;
      line-height: 1.45;
      overflow-wrap: anywhere;
    }

    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }

    .bulkbar {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 10px;
      margin: -6px 0 18px;
      padding: 10px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #15171b;
      color: var(--muted);
      font-size: 13px;
    }

    .bulkbar.hidden {
      display: none;
    }

    .bulkbar strong {
      color: var(--text);
      font-weight: 650;
    }

    .modal {
      position: fixed;
      inset: 0;
      z-index: 20;
      display: grid;
      place-items: center;
      padding: 22px;
      background: rgba(0, 0, 0, 0.58);
    }

    .modal.hidden {
      display: none;
    }

    .modal-panel {
      width: min(720px, 100%);
      max-height: calc(100vh - 44px);
      overflow: auto;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #15171b;
      padding: 18px;
      box-shadow: 0 24px 80px rgba(0, 0, 0, 0.45);
    }

    .modal-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 14px;
    }

    .modal-head h2 {
      font-size: 18px;
    }

    .settings-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 12px;
    }

    label.field {
      display: grid;
      gap: 6px;
      color: var(--muted);
      font-size: 12px;
    }

    .check-row {
      display: flex;
      flex-wrap: wrap;
      gap: 14px;
      margin-top: 14px;
      color: var(--muted);
      font-size: 13px;
    }

    .check-row label {
      display: inline-flex;
      align-items: center;
      gap: 7px;
    }

    .check-row input {
      width: 16px;
      height: 16px;
      padding: 0;
      accent-color: var(--accent);
    }

    .modal-actions {
      display: flex;
      justify-content: flex-end;
      gap: 10px;
      margin-top: 18px;
    }

    .button {
      display: inline-flex;
      align-items: center;
      height: 34px;
      padding: 0 11px;
      border: 1px solid var(--line);
      border-radius: 7px;
      background: #15171b;
      color: var(--text);
      text-decoration: none;
      font-size: 13px;
    }

    .primary {
      border-color: rgba(255, 81, 72, 0.55);
      background: rgba(255, 81, 72, 0.14);
    }

    .success {
      border-color: rgba(101, 209, 138, 0.55);
      background: rgba(101, 209, 138, 0.12);
    }

    .danger {
      border-color: rgba(255, 116, 104, 0.58);
      background: rgba(255, 81, 72, 0.12);
    }

    .subtle {
      color: var(--muted);
    }

    .message {
      margin-bottom: 12px;
      min-height: 20px;
      color: var(--muted);
      font-size: 13px;
    }

    .deleted {
      display: none;
      margin-bottom: 18px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #15171b;
      padding: 12px;
      color: var(--muted);
      font-size: 12px;
    }

    .deleted.visible {
      display: block;
    }

    .deleted strong {
      color: var(--text);
      font-size: 13px;
    }

    .deleted-row {
      margin-top: 7px;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      overflow-wrap: anywhere;
    }

    .empty {
      border: 1px dashed var(--line);
      border-radius: 8px;
      padding: 32px;
      color: var(--muted);
      text-align: center;
    }

    @media (max-width: 1120px) {
      .bar {
        grid-template-columns: 1fr;
        align-items: stretch;
        padding: 18px;
      }

      .tools {
        grid-template-columns: repeat(3, minmax(0, 1fr));
      }

      main {
        padding: 18px;
      }
    }

    @media (max-width: 760px) {
      .tools {
        grid-template-columns: 1fr;
      }

      .grid.list-view .card {
        display: block;
      }

      .grid.list-view .thumb {
        aspect-ratio: 16 / 9;
        min-height: 0;
        border-right: 0;
        border-bottom: 1px solid var(--line);
      }
    }
  </style>
</head>
<body>
  <header>
    <div class="bar">
      <div>
        <h1>HyperFrames Project Index</h1>
        <p id="root" class="root"></p>
      </div>
      <div class="tools">
        <input id="search" type="search" placeholder="Search projects" />
        <select id="sort">
          <option value="active-newest">Active, newest</option>
          <option value="newest">Newest first</option>
          <option value="oldest">Oldest first</option>
          <option value="name">Name A-Z</option>
        </select>
        <button id="activeOnly" type="button" aria-pressed="false">Active only</button>
        <button id="stopAll" class="danger" type="button" disabled>Stop all</button>
        <button id="viewMode" type="button" aria-pressed="false">List view</button>
        <button id="renderSettingsButton" type="button">Render Settings</button>
        <button id="chooseRoot" type="button">Choose Folder</button>
        <button id="refresh" type="button">Refresh</button>
      </div>
    </div>
  </header>
  <main>
    <div id="message" class="message"></div>
    <div id="deleted" class="deleted"></div>
    <div id="summary" class="summary"></div>
    <div id="bulkbar" class="bulkbar hidden"></div>
    <section id="grid" class="grid" aria-live="polite"></section>
  </main>
  <div id="renderSettingsModal" class="modal hidden" role="dialog" aria-modal="true" aria-labelledby="renderSettingsTitle">
    <div class="modal-panel">
      <div class="modal-head">
        <h2 id="renderSettingsTitle">Render Settings</h2>
        <button id="closeRenderSettings" type="button">Close</button>
      </div>
      <div class="settings-grid">
        <label class="field">Format
          <select id="renderFormat">
            <option value="mp4">MP4</option>
            <option value="webm">WebM</option>
            <option value="mov">MOV</option>
          </select>
        </label>
        <label class="field">Codec
          <select id="renderCodec">
            <option value="hevc">HEVC</option>
            <option value="native">Native / H.264</option>
          </select>
        </label>
        <label class="field">Quality
          <select id="renderQuality">
            <option value="draft">Draft</option>
            <option value="standard">Standard</option>
            <option value="high">High</option>
          </select>
        </label>
        <label class="field">FPS
          <select id="renderFps">
            <option value="24">24</option>
            <option value="30">30</option>
            <option value="60">60</option>
          </select>
        </label>
        <label class="field">Resolution
          <select id="renderResolution">
            <option value="">Composition default</option>
            <option value="landscape">Landscape 1080p</option>
            <option value="portrait">Portrait 1080p</option>
            <option value="landscape-4k">Landscape 4K</option>
            <option value="portrait-4k">Portrait 4K</option>
          </select>
        </label>
        <label class="field">Workers
          <input id="renderWorkers" type="text" placeholder="auto" />
        </label>
        <label class="field">CRF
          <input id="renderCrf" type="text" placeholder="Optional" />
        </label>
        <label class="field">Video Bitrate
          <input id="renderBitrate" type="text" placeholder="Example: 12M" />
        </label>
        <label class="field">Browser GPU
          <select id="renderBrowserGpu">
            <option value="auto">Auto</option>
            <option value="on">On</option>
            <option value="off">Off</option>
          </select>
        </label>
      </div>
      <div class="check-row">
        <label><input id="renderGpu" type="checkbox" /> GPU encoding</label>
        <label><input id="renderStrict" type="checkbox" /> Strict</label>
        <label><input id="renderStrictAll" type="checkbox" /> Strict all</label>
      </div>
      <div class="modal-actions">
        <button id="cancelRenderSettings" type="button">Cancel</button>
        <button id="saveRenderSettings" class="primary" type="button">Save Settings</button>
      </div>
    </div>
  </div>
  <script>
    const state = {
      projects: [],
      deleted: [],
      activeOnly: false,
      query: "",
      sort: "active-newest",
      view: "grid",
      renderSettings: null,
      renderJobs: [],
      selected: new Set(),
      busy: new Map(),
      stopAllBusy: false,
    };
    const grid = document.querySelector("#grid");
    const root = document.querySelector("#root");
    const summary = document.querySelector("#summary");
    const message = document.querySelector("#message");
    const deleted = document.querySelector("#deleted");
    const bulkbar = document.querySelector("#bulkbar");
    const search = document.querySelector("#search");
    const sort = document.querySelector("#sort");
    const activeOnly = document.querySelector("#activeOnly");
    const stopAll = document.querySelector("#stopAll");
    const viewMode = document.querySelector("#viewMode");
    const renderSettingsButton = document.querySelector("#renderSettingsButton");
    const renderSettingsModal = document.querySelector("#renderSettingsModal");
    const closeRenderSettings = document.querySelector("#closeRenderSettings");
    const cancelRenderSettings = document.querySelector("#cancelRenderSettings");
    const saveRenderSettings = document.querySelector("#saveRenderSettings");
    const chooseRoot = document.querySelector("#chooseRoot");

    function formatDuration(seconds) {
      if (!Number.isFinite(seconds)) return null;
      const mins = Math.floor(seconds / 60);
      const secs = Math.round(seconds % 60).toString().padStart(2, "0");
      return mins + ":" + secs;
    }

    function escapeHtml(value) {
      return String(value ?? "").replace(/[&<>"']/g, (char) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#039;",
      })[char]);
    }

    function showMessage(text, tone = "muted") {
      message.textContent = text || "";
      message.style.color = tone === "error" ? "#ff9b91" : "var(--muted)";
    }

    function projectTime(project) {
      return Date.parse(project.modifiedAt || "") || 0;
    }

    function formatDate(value) {
      const time = Date.parse(value || "");
      if (!time) return null;
      return new Date(time).toLocaleString();
    }

    function delay(ms) {
      return new Promise((resolve) => setTimeout(resolve, ms));
    }

    function setBusy(id, action) {
      state.busy.set(id, { action, startedAt: Date.now() });
    }

    function clearBusy(id) {
      state.busy.delete(id);
    }

    function projectIsActive(id) {
      return state.projects.some((project) => project.id === id && project.activeServers.length > 0);
    }

    function markProjectStopped(id) {
      const project = state.projects.find((item) => item.id === id);
      if (!project) return;
      project.activeServers = [];
      project.studioUrls = [];
    }

    function renderJobFor(project) {
      return project.renderJob || state.renderJobs.find((job) => job.project === project.id) || null;
    }

    function hasRunningRenderJobs() {
      return state.renderJobs.some((job) => job.status === "queued" || job.status === "running");
    }

    function mergeStartedProject(result) {
      if (!result?.project || !Array.isArray(result.ports) || !result.ports.length) return;
      const project = state.projects.find((item) => item.id === result.project);
      if (!project) return;

      project.activeServers = result.ports.map((port, index) => ({
        port,
        project: result.project,
        dir: project.dir,
        pid: index === 0 ? result.pid || null : null,
      }));
      project.studioUrls = result.studioUrls || result.ports.map((port) =>
        "http://localhost:" + port + "/#project/" + result.project
      );
    }

    function sortedProjects(projects) {
      return [...projects].sort((a, b) => {
        if (state.sort === "active-newest") {
          if (a.activeServers.length !== b.activeServers.length) {
            return b.activeServers.length - a.activeServers.length;
          }
          const timeDelta = projectTime(b) - projectTime(a);
          if (timeDelta) return timeDelta;
          return a.id.localeCompare(b.id);
        }

        if (state.sort === "newest") {
          const timeDelta = projectTime(b) - projectTime(a);
          if (timeDelta) return timeDelta;
          return a.id.localeCompare(b.id);
        }

        if (state.sort === "oldest") {
          const timeDelta = projectTime(a) - projectTime(b);
          if (timeDelta) return timeDelta;
          return a.id.localeCompare(b.id);
        }

        return a.id.localeCompare(b.id);
      });
    }

    function visibleProjects() {
      const query = state.query.trim().toLowerCase();
      return sortedProjects(state.projects.filter((project) => {
        const matchesQuery = !query ||
          project.id.toLowerCase().includes(query) ||
          project.title.toLowerCase().includes(query) ||
          project.dir.toLowerCase().includes(query);
        const matchesActive = !state.activeOnly || project.activeServers.length > 0;
        return matchesQuery && matchesActive;
      }));
    }

    function selectableVisibleProjects() {
      return visibleProjects().filter((project) => project.canDelete);
    }

    function renderBulkbar(visible) {
      const selectedCount = state.selected.size;
      if (!selectedCount && !visible.length) {
        bulkbar.className = "bulkbar hidden";
        bulkbar.innerHTML = "";
        return;
      }

      const selectableCount = visible.filter((project) => project.canDelete).length;
      bulkbar.className = "bulkbar";
      bulkbar.innerHTML =
        '<strong>' + selectedCount + '</strong> selected' +
        '<button type="button" data-select-visible>Select visible (' + selectableCount + ')</button>' +
        '<button type="button" data-clear-selection' + (!selectedCount ? " disabled" : "") + '>Clear</button>' +
        '<button class="danger" type="button" data-delete-selected' + (!selectedCount ? " disabled" : "") + '>Delete selected</button>';
    }

    function renderSettingValue(id, value) {
      const element = document.querySelector("#" + id);
      if (!element) return;
      if (element.type === "checkbox") element.checked = Boolean(value);
      else element.value = value ?? "";
    }

    function fillRenderSettingsForm() {
      const settings = state.renderSettings || {};
      renderSettingValue("renderFormat", settings.format || "mp4");
      renderSettingValue("renderCodec", settings.codec || "hevc");
      renderSettingValue("renderQuality", settings.quality || "standard");
      renderSettingValue("renderFps", settings.fps || "30");
      renderSettingValue("renderResolution", settings.resolution || "");
      renderSettingValue("renderWorkers", settings.workers || "auto");
      renderSettingValue("renderCrf", settings.crf || "");
      renderSettingValue("renderBitrate", settings.videoBitrate || "");
      renderSettingValue("renderBrowserGpu", settings.browserGpu || "auto");
      renderSettingValue("renderGpu", settings.gpu);
      renderSettingValue("renderStrict", settings.strict);
      renderSettingValue("renderStrictAll", settings.strictAll);
    }

    function collectRenderSettingsForm() {
      return {
        format: document.querySelector("#renderFormat").value,
        codec: document.querySelector("#renderCodec").value,
        quality: document.querySelector("#renderQuality").value,
        fps: document.querySelector("#renderFps").value,
        resolution: document.querySelector("#renderResolution").value,
        workers: document.querySelector("#renderWorkers").value,
        crf: document.querySelector("#renderCrf").value,
        videoBitrate: document.querySelector("#renderBitrate").value,
        browserGpu: document.querySelector("#renderBrowserGpu").value,
        gpu: document.querySelector("#renderGpu").checked,
        strict: document.querySelector("#renderStrict").checked,
        strictAll: document.querySelector("#renderStrictAll").checked,
      };
    }

    function openRenderSettings() {
      fillRenderSettingsForm();
      renderSettingsModal.className = "modal";
    }

    function closeRenderSettingsModal() {
      renderSettingsModal.className = "modal hidden";
    }

    function render() {
      const visible = visibleProjects();

      const activeCount = state.projects.filter((project) => project.activeServers.length > 0).length;
      stopAll.disabled = state.stopAllBusy || activeCount === 0;
      stopAll.textContent = state.stopAllBusy ? "Stopping all..." : "Stop all";
      summary.innerHTML = [
        "<span>" + state.projects.length + " projects</span>",
        "<span>" + activeCount + " active previews</span>",
        "<span>" + visible.length + " shown</span>",
      ].join("");
      renderBulkbar(visible);

      if (state.deleted.length) {
        deleted.className = "deleted visible";
        deleted.innerHTML = "<strong>Recently deleted</strong>" + state.deleted.slice(0, 5).map((record) =>
          '<div class="deleted-row">' + escapeHtml(record.id) + " -> " + escapeHtml(record.to) + '</div>'
        ).join("");
      } else {
        deleted.className = "deleted";
        deleted.innerHTML = "";
      }

      if (!visible.length) {
        grid.className = "empty";
        grid.textContent = "No projects match the current filter.";
        return;
      }

      grid.className = state.view === "list" ? "grid list-view" : "grid";
      grid.innerHTML = visible.map((project) => {
        const duration = formatDuration(project.duration);
        const status = project.activeServers.length ? "Active" : "Not running";
        const busy = state.busy.get(project.id);
        const isBusy = Boolean(busy);
        const busyAction = busy?.action || null;
        const renderJob = renderJobFor(project);
        const isRendering = renderJob && (renderJob.status === "queued" || renderJob.status === "running");
        const studioLinks = project.studioUrls.map((url, index) =>
          '<a class="button primary" href="' + escapeHtml(url) + '">Studio ' + escapeHtml(project.activeServers[index].port) + '</a>'
        ).join("");
        const control = project.activeServers.length || busyAction === "stop"
          ? '<button class="danger" type="button" data-stop-project="' + escapeHtml(project.id) + '"' + (isBusy ? " disabled" : "") + '>' + (busyAction === "stop" ? "Stopping..." : "Stop") + '</button>'
          : '<button class="success" type="button" data-start-project="' + escapeHtml(project.id) + '"' + (isBusy ? " disabled" : "") + '>' + (busyAction === "start" ? "Starting..." : "Start") + '</button>';
        const openFolder = '<button type="button" data-open-project="' + escapeHtml(project.id) + '" data-open-target="folder">Open Folder</button>';
        const openRender = project.latestRender
          ? '<button type="button" data-open-project="' + escapeHtml(project.id) + '" data-open-target="render">Open Render</button>'
          : "";
        const deleteButton = project.canDelete
          ? '<button class="danger" type="button" data-delete-project="' + escapeHtml(project.id) + '"' + (isBusy ? " disabled" : "") + '>Delete</button>'
          : '<button type="button" disabled title="The selected root folder itself cannot be deleted here.">Root</button>';
        const command = project.activeServers.length ? "" : '<p class="command">' + escapeHtml(project.command) + '</p>';
        const thumb = project.thumbnailUrl
          ? '<img src="' + escapeHtml(project.thumbnailUrl) + '" alt="' + escapeHtml(project.id) + ' preview" loading="lazy" />'
          : '<span>No thumbnail</span>';
        const snapshotLabel = project.thumbnailUrl ? "Update Snapshot" : "Generate Snapshot";
        const snapshotButton = '<button type="button" data-snapshot-project="' + escapeHtml(project.id) + '"' + (isBusy ? " disabled" : "") + '>' + (busyAction === "snapshot" ? "Generating..." : snapshotLabel) + '</button>';
        const renderButton = '<button class="primary" type="button" data-render-project="' + escapeHtml(project.id) + '"' + (isRendering ? " disabled" : "") + '>' + (isRendering ? "Rendering..." : "Render") + '</button>';
        const checkbox = project.canDelete
          ? '<label class="card-select" title="Select project"><input type="checkbox" data-select-project="' + escapeHtml(project.id) + '"' + (state.selected.has(project.id) ? " checked" : "") + ' /></label>'
          : "";
        const chips = [
          project.compositionId,
          project.size,
          duration,
          formatDate(project.modifiedAt),
          project.activeServers.length ? "ports: " + project.activeServers.map((server) => server.port).join(", ") : null,
          project.compositionCount ? project.compositionCount + " compositions" : null,
          project.mediaCount ? project.mediaCount + " media" : null,
          project.latestRender ? "render: " + project.latestRender : null,
          renderJob ? "job: " + renderJob.status + (renderJob.phase ? " / " + renderJob.phase : "") : null,
        ].filter(Boolean).map((item) => '<span class="chip">' + escapeHtml(item) + '</span>').join("");

        return '<article class="card">' +
          checkbox +
          '<div class="thumb">' + thumb + '</div>' +
          '<div class="body">' +
            '<div class="title-row">' +
              '<h2>' + escapeHtml(project.id) + '</h2>' +
              '<span class="status ' + (project.activeServers.length ? "active" : "") + '">' + status + '</span>' +
            '</div>' +
            '<p class="path">' + escapeHtml(project.dir) + '</p>' +
            '<div class="meta">' + chips + '</div>' +
            command +
            '<div class="actions">' + control + renderButton + studioLinks + openFolder + openRender + snapshotButton + deleteButton + '</div>' +
          '</div>' +
        '</article>';
      }).join("");
    }

    async function postJson(url, body, options = {}) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), options.timeoutMs || 25000);

      try {
        const response = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body || {}),
          signal: controller.signal,
        });
        const text = await response.text();
        const data = text ? JSON.parse(text) : {};
        if (!response.ok) {
          throw new Error(data.error || text || "Request failed");
        }
        return data;
      } catch (error) {
        if (error.name === "AbortError") {
          throw new Error("Request timed out. Refreshing project state.");
        }
        throw error;
      } finally {
        clearTimeout(timeout);
      }
    }

    async function waitForProjectActive(id, maxAttempts = 14) {
      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        await delay(attempt < 4 ? 850 : 1500);
        await load();
        if (projectIsActive(id)) return true;
      }
      return false;
    }

    async function mutateProject(action, id) {
      setBusy(id, action);
      render();

      try {
        const result = await postJson("/api/" + action, { id }, {
          timeoutMs: action === "start" ? 45000 : 18000,
        });

        if (action === "start") {
          mergeStartedProject(result);
          if (projectIsActive(id)) {
            clearBusy(id);
            render();
            load().catch((error) => showMessage(error.message, "error"));
            return;
          }

          showMessage("Preview launched. Waiting for HyperFrames to report the active port...");
          const detected = await waitForProjectActive(id);
          if (!detected) {
            showMessage("Preview may be open, but the dashboard could not detect its port yet. Use Refresh once it finishes starting.", "error");
          }
          return;
        }

        markProjectStopped(id);
        clearBusy(id);
        render();
        await delay(700);
        await load();
      } catch (error) {
        showMessage(error.message, "error");
        await load().catch(() => {});
      } finally {
        clearBusy(id);
        render();
      }
    }

    async function generateSnapshot(id) {
      setBusy(id, "snapshot");
      render();

      try {
        showMessage("Generating snapshot for " + id + "...");
        await postJson("/api/snapshot", { id, force: true }, { timeoutMs: 60000 });
        await load();
        showMessage("Snapshot updated for " + id + ".");
      } catch (error) {
        showMessage(error.message, "error");
        await load().catch(() => {});
      } finally {
        clearBusy(id);
        render();
      }
    }

    async function startRender(id) {
      try {
        const job = await postJson("/api/render", { id }, { timeoutMs: 12000 });
        state.renderJobs = [job, ...state.renderJobs.filter((item) => item.id !== job.id)];
        showMessage("Render started for " + id + ".");
        render();
        scheduleRenderPoll();
      } catch (error) {
        showMessage(error.message, "error");
        await load().catch(() => {});
      }
    }

    let renderPollTimer = null;

    function scheduleRenderPoll() {
      if (renderPollTimer) return;
      renderPollTimer = setTimeout(async () => {
        renderPollTimer = null;
        try {
          const response = await fetch("/api/render-jobs", { cache: "no-store" });
          if (response.ok) {
            const data = await response.json();
            state.renderJobs = data.renderJobs || [];
            for (const project of state.projects) {
              project.renderJob = state.renderJobs.find((job) => job.project === project.id) || project.renderJob || null;
            }
            render();
          }
          if (hasRunningRenderJobs()) scheduleRenderPoll();
          else await load();
        } catch (error) {
          showMessage(error.message, "error");
        }
      }, 2200);
    }

    async function deleteSelectedProjects() {
      const ids = Array.from(state.selected);
      if (!ids.length) return;
      const confirmText = window.prompt(
        'Type "DELETE" to move ' + ids.length + ' selected projects to Trash.\\n\\n' + ids.join("\\n")
      );
      if (confirmText === null) return;

      for (const id of ids) setBusy(id, "delete");
      render();

      try {
        const result = await postJson("/api/delete-bulk", { ids, confirmText }, { timeoutMs: 120000 });
        const failed = (result.results || []).filter((item) => item.status === "error");
        state.selected.clear();
        await load();
        if (failed.length) {
          showMessage("Deleted with " + failed.length + " failures. Check recently deleted and remaining cards.", "error");
        } else {
          showMessage("Moved " + ids.length + " projects to Trash.");
        }
      } catch (error) {
        showMessage(error.message, "error");
        await load().catch(() => {});
      } finally {
        for (const id of ids) clearBusy(id);
        render();
      }
    }

    async function load() {
      summary.innerHTML = "<span>Scanning projects...</span>";
      showMessage("");
      const [projectResponse, deletedResponse] = await Promise.all([
        fetch("/api/projects", { cache: "no-store" }),
        fetch("/api/deleted", { cache: "no-store" }),
      ]);
      if (!projectResponse.ok) throw new Error("Failed to load project index");
      const data = await projectResponse.json();
      const deletedData = deletedResponse.ok ? await deletedResponse.json() : { deleted: [] };
      root.textContent = data.rootDir;
      state.projects = data.projects;
      state.deleted = deletedData.deleted || [];
      state.renderSettings = data.renderSettings || state.renderSettings;
      state.renderJobs = data.renderJobs || [];
      const projectIds = new Set(state.projects.map((project) => project.id));
      for (const id of Array.from(state.selected)) {
        if (!projectIds.has(id)) state.selected.delete(id);
      }
      render();
      if (hasRunningRenderJobs()) scheduleRenderPoll();
    }

    search.addEventListener("input", () => {
      state.query = search.value;
      render();
    });

    sort.addEventListener("change", () => {
      state.sort = sort.value;
      render();
    });

    activeOnly.addEventListener("click", () => {
      state.activeOnly = !state.activeOnly;
      activeOnly.setAttribute("aria-pressed", String(state.activeOnly));
      activeOnly.textContent = state.activeOnly ? "Show all" : "Active only";
      render();
    });

    stopAll.addEventListener("click", async () => {
      const activeIds = state.projects
        .filter((project) => project.activeServers.length > 0)
        .map((project) => project.id);
      if (!activeIds.length) return;

      state.stopAllBusy = true;
      for (const id of activeIds) setBusy(id, "stop");
      render();

      try {
        const result = await postJson("/api/stop-all", {}, { timeoutMs: 60000 });
        for (const id of activeIds) markProjectStopped(id);
        await load();
        showMessage("Stopped " + result.count + " preview server" + (result.count === 1 ? "." : "s."));
      } catch (error) {
        showMessage(error.message, "error");
        await load().catch(() => {});
      } finally {
        state.stopAllBusy = false;
        for (const id of activeIds) clearBusy(id);
        render();
      }
    });

    viewMode.addEventListener("click", () => {
      state.view = state.view === "grid" ? "list" : "grid";
      viewMode.setAttribute("aria-pressed", String(state.view === "list"));
      viewMode.textContent = state.view === "list" ? "Grid view" : "List view";
      render();
    });

    renderSettingsButton.addEventListener("click", () => {
      openRenderSettings();
    });

    closeRenderSettings.addEventListener("click", closeRenderSettingsModal);
    cancelRenderSettings.addEventListener("click", closeRenderSettingsModal);

    saveRenderSettings.addEventListener("click", async () => {
      try {
        saveRenderSettings.disabled = true;
        const data = await postJson("/api/render-settings", { settings: collectRenderSettingsForm() });
        state.renderSettings = data.renderSettings;
        closeRenderSettingsModal();
        showMessage("Render settings saved.");
        render();
      } catch (error) {
        showMessage(error.message, "error");
      } finally {
        saveRenderSettings.disabled = false;
      }
    });

    document.querySelector("#refresh").addEventListener("click", () => {
      load().catch((error) => {
        showMessage(error.message, "error");
      });
    });

    chooseRoot.addEventListener("click", async () => {
      try {
        chooseRoot.disabled = true;
        showMessage("Opening folder chooser...");
        await postJson("/api/root/choose");
        await load();
      } catch (error) {
        showMessage(error.message, "error");
      } finally {
        chooseRoot.disabled = false;
      }
    });

    bulkbar.addEventListener("click", (event) => {
      if (event.target.closest("[data-select-visible]")) {
        for (const project of selectableVisibleProjects()) {
          state.selected.add(project.id);
        }
        render();
        return;
      }

      if (event.target.closest("[data-clear-selection]")) {
        state.selected.clear();
        render();
        return;
      }

      if (event.target.closest("[data-delete-selected]")) {
        deleteSelectedProjects();
      }
    });

    grid.addEventListener("click", (event) => {
      const selectInput = event.target.closest("[data-select-project]");
      if (selectInput) {
        const id = selectInput.dataset.selectProject;
        if (selectInput.checked) state.selected.add(id);
        else state.selected.delete(id);
        render();
        return;
      }

      const startButton = event.target.closest("[data-start-project]");
      const stopButton = event.target.closest("[data-stop-project]");
      const openButton = event.target.closest("[data-open-project]");
      const deleteButton = event.target.closest("[data-delete-project]");
      const snapshotButton = event.target.closest("[data-snapshot-project]");
      const renderButton = event.target.closest("[data-render-project]");
      const id = startButton?.dataset.startProject ||
        stopButton?.dataset.stopProject ||
        openButton?.dataset.openProject ||
        deleteButton?.dataset.deleteProject ||
        snapshotButton?.dataset.snapshotProject ||
        renderButton?.dataset.renderProject;
      if (!id) return;

      if (startButton || stopButton) {
        mutateProject(startButton ? "start" : "stop", id).catch((error) => {
          showMessage(error.message, "error");
        });
        return;
      }

      if (openButton) {
        postJson("/api/open", { id, target: openButton.dataset.openTarget }).catch((error) => {
          showMessage(error.message, "error");
        });
        return;
      }

      if (snapshotButton) {
        generateSnapshot(id);
        return;
      }

      if (renderButton) {
        startRender(id);
        return;
      }

      if (deleteButton) {
        const confirmName = window.prompt('Type "' + id + '" to move this project to Trash.');
        if (confirmName === null) return;
        setBusy(id, "delete");
        render();
        postJson("/api/delete", { id, confirmName })
          .then(() => load())
          .catch((error) => {
            clearBusy(id);
            render();
            showMessage(error.message, "error");
          });
      }
    });

    load().catch((error) => {
      showMessage(error.message, "error");
    });
  </script>
</body>
</html>`);
}

function serveFile(req, res, url) {
  const rawPath = url.searchParams.get("path");
  if (!rawPath) {
    json(res, 400, { error: "missing path" });
    return;
  }

  const filePath = path.resolve(rawPath);
  const inRoot = filePath === rootDir || filePath.startsWith(rootDir + path.sep);
  const inThumbnailCache = filePath.startsWith(thumbnailCacheDir + path.sep);
  if (!inRoot && !inThumbnailCache) {
    json(res, 403, { error: "forbidden" });
    return;
  }

  const type = imageTypes.get(path.extname(filePath).toLowerCase());
  if (!type) {
    json(res, 415, { error: "unsupported media type" });
    return;
  }

  const stream = createReadStream(filePath);
  stream.on("error", () => json(res, 404, { error: "not found" }));
  res.writeHead(200, {
    "content-type": type,
    "cache-control": "no-store",
  });
  stream.pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://localhost");

  try {
    if (url.pathname === "/") {
      html(res);
      return;
    }

    if (url.pathname === "/api/projects") {
      json(res, 200, await scanProjects());
      return;
    }

    if (url.pathname === "/api/deleted") {
      json(res, 200, { deleted: await deletedRecords() });
      return;
    }

    if (url.pathname === "/api/render-settings" && req.method === "GET") {
      json(res, 200, { renderSettings: await loadRenderSettings() });
      return;
    }

    if (url.pathname === "/api/render-settings" && req.method === "POST") {
      const body = await readJsonBody(req);
      json(res, 200, { renderSettings: await saveRenderSettings(body.settings || body) });
      return;
    }

    if (url.pathname === "/api/render-jobs") {
      json(res, 200, { renderJobs: renderJobSummaries() });
      return;
    }

    if (url.pathname === "/api/root/choose" && req.method === "POST") {
      json(res, 200, await chooseRootDir());
      return;
    }

    if (url.pathname === "/api/start" && req.method === "POST") {
      const body = await readJsonBody(req);
      json(res, 200, await startProject(body.id));
      return;
    }

    if (url.pathname === "/api/stop" && req.method === "POST") {
      const body = await readJsonBody(req);
      json(res, 200, await stopProject(body.id));
      return;
    }

    if (url.pathname === "/api/stop-all" && req.method === "POST") {
      json(res, 200, await stopAllProjects());
      return;
    }

    if (url.pathname === "/api/delete" && req.method === "POST") {
      const body = await readJsonBody(req);
      json(res, 200, await deleteProject(body.id, body.confirmName));
      return;
    }

    if (url.pathname === "/api/delete-bulk" && req.method === "POST") {
      const body = await readJsonBody(req);
      json(res, 200, await deleteProjects(body.ids, body.confirmText));
      return;
    }

    if (url.pathname === "/api/snapshot" && req.method === "POST") {
      const body = await readJsonBody(req);
      json(res, 200, await generateProjectSnapshot(body.id, { force: Boolean(body.force) }));
      return;
    }

    if (url.pathname === "/api/render" && req.method === "POST") {
      const body = await readJsonBody(req);
      json(res, 200, await startRenderJob(body.id, body.settings || {}));
      return;
    }

    if (url.pathname === "/api/open" && req.method === "POST") {
      const body = await readJsonBody(req);
      json(res, 200, await openProjectTarget(body.id, body.target));
      return;
    }

    if (url.pathname === "/file") {
      serveFile(req, res, url);
      return;
    }

    json(res, 404, { error: "not found" });
  } catch (error) {
    json(res, 500, { error: error.message });
  }
});

function listen(port) {
  server.once("error", (error) => {
    if (error.code === "EADDRINUSE") {
      listen(port + 1);
      return;
    }
    throw error;
  });

  server.listen(port, "127.0.0.1", () => {
    const address = server.address();
    console.log(`HyperFrames project index`);
    console.log(`Root     ${rootDir}`);
    console.log(`Config   ${configPath}`);
    console.log(`Index    http://localhost:${address.port}`);
  });
}

rootDir = await loadInitialRootDir();
try {
  await validateRootDir(rootDir);
} catch (error) {
  const fallbackRootDir = path.resolve(defaultRootDir);
  if (fallbackRootDir !== rootDir) {
    console.warn(`Configured root is invalid: ${error.message}`);
    console.warn(`Falling back to ${fallbackRootDir}`);
    rootDir = fallbackRootDir;
    await validateRootDir(rootDir);
  } else {
    throw error;
  }
}
await saveRootDir(rootDir);
try {
  const cachedCount = await refreshThumbnailCache();
  console.log(`Thumbnails ${cachedCount} cached`);
} catch (error) {
  console.warn(`Thumbnail cache refresh failed: ${error.message}`);
}
listen(preferredPort);
