// server.js
const express = require('express');
const { spawn } = require('child_process');
const fs = require('fs');
const fsPromises = require('fs').promises;
const os = require('os');
const path = require('path');

const app = express();
app.use(express.json({ limit: '10mb' }));

const TMP = os.tmpdir();
const MAX_DOWNLOAD_SECONDS = 60 * 10; // safety for download timeout

function safePath(name) {
  return path.join(TMP, `${Date.now()}-${Math.random().toString(36).slice(2,8)}-${name}`);
}

function parseSecondsOrHMS(input) {
  // Accept number or HH:MM:SS or "123"
  if (typeof input === 'number' && Number.isFinite(input)) return Math.floor(input);
  if (typeof input === 'string') {
    if (input.includes(':')) {
      const parts = input.split(':').map(Number).reverse();
      let seconds = 0;
      if (parts[0]) seconds += parts[0];
      if (parts[1]) seconds += parts[1] * 60;
      if (parts[2]) seconds += parts[2] * 3600;
      return Math.floor(seconds);
    }
    const n = Number(input);
    if (!Number.isNaN(n)) return Math.floor(n);
  }
  throw new Error('Invalid time format');
}

// Helper to run a command with args and forward stdout/stderr
function runCommand(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, opts);
    let stderr = '';
    p.stderr.on('data', (c) => { stderr += c.toString(); });
    p.on('error', (err) => reject(err));
    p.on('close', (code) => {
      if (code !== 0) {
        const err = new Error(`${cmd} ${args.join(' ')} exited ${code}: ${stderr}`);
        err.code = code;
        err.stderr = stderr;
        return reject(err);
      }
      resolve({ stderr });
    });
  });
}

app.post('/clip', async (req, res) => {
  const start = Date.now();
  try {
    const { vodUrl, startTime, endTime } = req.body || {};

    if (!vodUrl || !startTime || !endTime) {
      return res.status(400).json({ error: 'vodUrl, startTime, endTime are required' });
    }
    if (typeof vodUrl !== 'string' || (!vodUrl.startsWith('http://') && !vodUrl.startsWith('https://'))) {
      return res.status(400).json({ error: 'vodUrl must be absolute http/https URL' });
    }

    console.log('[clip] request', { vodUrl, startTime, endTime });

    // prepare paths
    const downloadPath = safePath('input.mp4');
    const outputPath = safePath('clip.mp4');

    // 1) Use yt-dlp to download the VOD to a single mp4 file
    // Command: yt-dlp -f best -o <downloadPath> <vodUrl>
    // Note: yt-dlp must be available in PATH (installed via pip in Dockerfile)
    console.log('[clip] starting yt-dlp download to', downloadPath);
    await runCommand('yt-dlp', ['-f', 'best', '--no-progress', '-o', downloadPath, vodUrl], { timeout: MAX_DOWNLOAD_SECONDS * 1000 })
      .catch((err) => {
        console.error('[clip] yt-dlp failed:', err.message || err);
        throw new Error('yt-dlp failed: ' + (err.stderr ? err.stderr.slice(0,2000) : err.message));
      });

    // assert file exists and has size
    if (!fs.existsSync(downloadPath)) {
      throw new Error('Download failed: file not created');
    }
    const stat = fs.statSync(downloadPath);
    console.log('[clip] downloaded size bytes=', stat.size);

    // 2) Trim with ffmpeg using start/end (use copy codec for speed if possible)
    // Convert times to seconds
    const startSec = parseSecondsOrHMS(startTime);
    const endSec = parseSecondsOrHMS(endTime);
    const duration = Math.max(0, endSec - startSec);
    if (duration <= 0) {
      throw new Error('endTime must be greater than startTime');
    }

    console.log('[clip] running ffmpeg trim startSec=', startSec, 'duration=', duration);

    // Build ffmpeg args:
    // -ss <start> -i input -t <duration> -c copy -avoid_negative_ts make_zero output
    const ffArgs = [
      '-hide_banner',
      '-loglevel', 'error',
      '-ss', String(startSec),
      '-i', downloadPath,
      '-t', String(duration),
      '-c', 'copy',
      '-avoid_negative_ts', 'make_zero',
      '-movflags', 'faststart',
      '-y',
      outputPath
    ];

    // Spawn ffmpeg and wait
    await runCommand('ffmpeg', ffArgs).catch((err) => {
      console.error('[clip] ffmpeg failed:', err.message || err);
      throw new Error('ffmpeg failed: ' + (err.stderr ? err.stderr.slice(0,2000) : err.message));
    });

    if (!fs.existsSync(outputPath)) {
      throw new Error('ffmpeg did not produce output');
    }
    const outStat = fs.statSync(outputPath);
    console.log('[clip] output size bytes=', outStat.size);

    // 3) Stream the output file to response
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', `attachment; filename="clip.mp4"`);
    res.setHeader('Content-Length', String(outStat.size));

    const stream = fs.createReadStream(outputPath);
    stream.on('end', async () => {
      // cleanup files ASAP
      try { await fsPromises.unlink(downloadPath).catch(()=>{}); } catch {}
      try { await fsPromises.unlink(outputPath).catch(()=>{}); } catch {}
      console.log('[clip] stream finished, cleaned up, elapsed ms=', Date.now()-start);
    });
    stream.on('error', async (err) => {
      console.error('[clip] stream error', err);
      try { await fsPromises.unlink(downloadPath).catch(()=>{}); } catch {}
      try { await fsPromises.unlink(outputPath).catch(()=>{}); } catch {}
    });

    stream.pipe(res);

  } catch (err) {
    console.error('[clip] fatal error', err && err.message ? err.message : err);
    // try to return JSON error
    try {
      if (!res.headersSent) {
        res.status(500).json({ error: 'Clip processing failed', details: String(err?.message || err) });
      } else {
        res.end();
      }
    } catch (e) {
      // ignore
    }
  }
});

// Health
app.get('/', (req,res) => res.json({ status: 'ok', service: 'ffmpeg-clip', now: Date.now() }));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server listening on ${port}`));
