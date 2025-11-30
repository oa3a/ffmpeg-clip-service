// server.js - robust clip service using yt-dlp + ffmpeg
const express = require('express');
const { spawn } = require('child_process');
const fs = require('fs');
const fsPromises = require('fs').promises;
const os = require('os');
const path = require('path');

const app = express();
app.use(express.json({ limit: '50mb' }));

// Helpers
function safeLog(...args) { console.log(...args); }
function isAbsoluteHttpUrl(s) {
  return typeof s === 'string' && (s.startsWith('http://') || s.startsWith('https://'));
}
function normalizeTime(value) {
  // Accept number seconds or "HH:MM:SS" or "mm:ss"
  if (typeof value === 'number' && Number.isFinite(value)) return Math.floor(value).toString();
  if (typeof value === 'string') return value;
  throw new Error('Invalid time format');
}
function runCommand(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => (stdout += d.toString()));
    proc.stderr.on('data', (d) => (stderr += d.toString()));
    proc.on('error', (err) => reject({ code: 'spawn_error', error: err, stderr, stdout }));
    proc.on('close', (code, signal) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject({ code, signal, stderr, stdout });
    });
  });
}

// Endpoint
app.post('/clip', async (req, res) => {
  const body = req.body || {};
  const vodUrl = body.vodUrl;
  const startTime = body.startTime;
  const endTime = body.endTime;

  if (!vodUrl || !isAbsoluteHttpUrl(vodUrl)) {
    return res.status(400).json({ error: 'vodUrl required and must be absolute (http/https)' });
  }
  if (startTime == null || endTime == null) {
    return res.status(400).json({ error: 'startTime and endTime are required' });
  }

  const normalizedStart = normalizeTime(startTime);
  const normalizedEnd = normalizeTime(endTime);

  const tmpBase = os.tmpdir();
  const workDir = fs.mkdtempSync(path.join(tmpBase, 'clipify-'));
  const downloadPath = path.join(workDir, 'source.mp4');
  const outputPath = path.join(workDir, 'clip.mp4');

  safeLog('Clip request', { vodUrl, startTime: normalizedStart, endTime: normalizedEnd, workDir });

  // Timeout guard: kill long-running processes after X ms
  const MAX_JOB_MS = Number(process.env.MAX_JOB_MS || 4 * 60 * 1000); // 4 minutes default

  let jobTimedOut = false;
  const jobTimeout = setTimeout(() => {
    jobTimedOut = true;
  }, MAX_JOB_MS);

  try {
    // Step 1: Download with yt-dlp (always use yt-dlp for Twitch/HLS)
    // Use -f best and write to a fixed filename
    safeLog('Running yt-dlp to download VOD...');
    try {
      await runCommand('yt-dlp', ['-f', 'best', vodUrl, '-o', downloadPath], { timeout: MAX_JOB_MS });
    } catch (err) {
      // Provide detailed error
      safeLog('yt-dlp failed:', err && (err.stderr || err));
      throw new Error(`yt-dlp failed: ${err && (err.stderr || err.code || err.signal || JSON.stringify(err))}`);
    }

    // Make sure file exists and has size
    const st = await fsPromises.stat(downloadPath);
    if (!st || st.size === 0) throw new Error('Downloaded file missing or empty');

    safeLog('Downloaded VOD to', downloadPath, 'size', st.size);

    // Step 2: Trim with ffmpeg (use -ss / -to with input file)
    // Use copy codecs for speed; if that fails we fallback to re-encode
    safeLog('Running ffmpeg trim (copy codec) ...');
    try {
      // Use -ss before -i may be faster but less accurate for copy; keep simplicity: -ss after input with -accurate_seek can be used.
      await runCommand('ffmpeg', [
        '-hide_banner',
        '-loglevel', 'warning',
        '-y',
        '-ss', normalizedStart,
        '-to', normalizedEnd,
        '-i', downloadPath,
        '-c', 'copy',
        outputPath
      ], { timeout: MAX_JOB_MS });
    } catch (errCopy) {
      safeLog('ffmpeg copy failed, trying re-encode fallback, error:', errCopy && (errCopy.stderr || errCopy));
      // fallback: re-encode to avoid format/copy issues
      try {
        await runCommand('ffmpeg', [
          '-hide_banner',
          '-loglevel', 'warning',
          '-y',
          '-ss', normalizedStart,
          '-to', normalizedEnd,
          '-i', downloadPath,
          '-c:v', 'libx264',
          '-c:a', 'aac',
          '-movflags', 'faststart',
          outputPath
        ], { timeout: MAX_JOB_MS });
      } catch (errRe) {
        safeLog('ffmpeg re-encode failed:', errRe && (errRe.stderr || errRe));
        throw new Error(`ffmpeg failed: ${errRe && (errRe.stderr || JSON.stringify(errRe))}`);
      }
    }

    const stOut = await fsPromises.stat(outputPath);
    if (!stOut || stOut.size === 0) throw new Error('FFmpeg produced empty output');

    safeLog('Trimmed clip ready, size:', stOut.size);

    // Stream file to response (don't load whole file into memory)
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', 'attachment; filename="clip.mp4"');
    res.setHeader('Content-Length', stOut.size);

    const readStream = fs.createReadStream(outputPath);
    readStream.pipe(res);

    // cleanup after stream finishes
    readStream.on('close', async () => {
      clearTimeout(jobTimeout);
      try {
        await fsPromises.unlink(downloadPath).catch(() => {});
        await fsPromises.unlink(outputPath).catch(() => {});
        await fsPromises.rmdir(workDir).catch(() => {});
        safeLog('Cleaned up workDir', workDir);
      } catch (cleanupErr) {
        safeLog('Cleanup error', cleanupErr);
      }
    });

    // If client disconnects, stop reading
    req.on('close', () => {
      readStream.destroy();
    });

  } catch (err) {
    clearTimeout(jobTimeout);
    safeLog('Clip processing failed:', err && (err.message || err));
    // Try to include underlying stderr if present
    const msg = err && err.message ? err.message : String(err);
    res.status(500).json({ error: 'Failed to process clip', message: msg });
    // cleanup
    try {
      await fsPromises.unlink(downloadPath).catch(() => {});
      await fsPromises.unlink(outputPath).catch(() => {});
      await fsPromises.rmdir(workDir).catch(() => {});
    } catch (cleanupErr) {}
  } finally {
    if (jobTimedOut) {
      safeLog('Job timed out (exceeded MAX_JOB_MS)');
    }
  }
});

// Health
app.get('/', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

// Catch uncaught exceptions
process.on('uncaughtException', (e) => {
  console.error('uncaughtException', e && e.stack ? e.stack : e);
});
process.on('unhandledRejection', (e) => {
  console.error('unhandledRejection', e && e.stack ? e.stack : e);
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Clip service listening on ${port}`);
});
