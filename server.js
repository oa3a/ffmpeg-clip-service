// server.cjs  (CommonJS)
const express = require('express');
const { spawn } = require('child_process');
const fs = require('fs');
const fsPromises = require('fs').promises;
const os = require('os');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(express.json({ limit: '50mb' }));

// Simple concurrency guard: allow 1 job at a time to avoid OOM/segfaults
let activeJobs = 0;
const MAX_CONCURRENT_JOBS = Number(process.env.MAX_CONCURRENT_JOBS || 1);

// Helper to run a command and collect stderr
function runCommand(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, opts);
    let stderr = '';
    let stdout = '';
    if (p.stdout) p.stdout.on('data', (d) => { stdout += d.toString(); });
    if (p.stderr) p.stderr.on('data', (d) => { stderr += d.toString(); });
    p.on('error', (err) => reject({ code: null, error: err, stderr, stdout }));
    p.on('close', (code, signal) => {
      if (code !== 0) {
        reject({ code, signal, stderr, stdout });
      } else {
        resolve({ code, signal, stderr, stdout });
      }
    });
  });
}

// parse times: accepts seconds (number) or "HH:MM:SS" or "MM:SS" or stringified number
function parseTimeToSeconds(t) {
  if (typeof t === 'number' && Number.isFinite(t)) return Math.max(0, t);
  const s = String(t || '').trim();
  if (s.includes(':')) {
    const parts = s.split(':').map(Number).reverse(); // seconds, minutes, hours
    let seconds = 0;
    if (!Number.isFinite(parts[0])) return NaN;
    seconds += parts[0];
    if (parts.length > 1 && Number.isFinite(parts[1])) seconds += parts[1] * 60;
    if (parts.length > 2 && Number.isFinite(parts[2])) seconds += parts[2] * 3600;
    return seconds;
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}

app.post('/clip', async (req, res) => {
  const { vodUrl, startTime, endTime } = req.body || {};

  try {
    if (!vodUrl || typeof vodUrl !== 'string') {
      return res.status(400).json({ error: 'vodUrl is required and must be a string' });
    }
    if (startTime == null || endTime == null) {
      return res.status(400).json({ error: 'startTime and endTime are required' });
    }

    // concurrency guard
    if (activeJobs >= MAX_CONCURRENT_JOBS) {
      return res.status(429).json({ error: 'Too many concurrent jobs, try again later' });
    }
    activeJobs += 1;

    console.log('Clip request:', { vodUrl, startTime, endTime });

    const tmpdir = path.join(os.tmpdir(), 'vod-to-viral');
    await fsPromises.mkdir(tmpdir, { recursive: true });

    const downloadPath = path.join(tmpdir, `vod-${uuidv4()}.mp4`);
    const outputPath = path.join(tmpdir, `clip-${uuidv4()}.mp4`);

    // Normalize times
    const startSec = parseTimeToSeconds(startTime);
    const endSec = parseTimeToSeconds(endTime);
    if (!Number.isFinite(startSec) || !Number.isFinite(endSec)) {
      throw new Error(`Invalid startTime or endTime. startTime=${startTime}, endTime=${endTime}`);
    }
    const duration = endSec - startSec;
    if (!(duration > 0)) {
      throw new Error(`Invalid clip duration (end <= start). start=${startSec}, end=${endSec}`);
    }

    // Step 1: Use yt-dlp to download to local MP4
    console.log('Downloading VOD with yt-dlp to', downloadPath);
    // Use -f bestvideo+bestaudio/best to ensure full mp4; -o sets path
    // We will make yt-dlp produce a single file with extension .mp4
    const ytdlpArgs = ['-f', 'best', vodUrl, '-o', downloadPath, '--no-warnings', '--no-progress'];
    try {
      await runCommand('yt-dlp', ytdlpArgs, { env: process.env });
    } catch (err) {
      console.error('yt-dlp failed:', err);
      throw new Error(`yt-dlp failed: ${err.stderr || err.error?.message || JSON.stringify(err)}`);
    }

    // confirm file
    let stats;
    try {
      stats = await fsPromises.stat(downloadPath);
    } catch (e) {
      throw new Error('yt-dlp did not produce a file');
    }
    console.log('Downloaded VOD size bytes:', stats.size);

    // Step 2: Trim with ffmpeg (use -ss before -i for fast seek, or use -ss after -i if accurate)
    // Use -ss start -t duration -i in that order with -c copy to be fast (works for most)
    const ffArgs = [
      '-ss', String(startSec),
      '-i', downloadPath,
      '-t', String(Math.max(0, duration)),
      '-c', 'copy',
      '-avoid_negative_ts', 'make_zero',
      '-y',
      outputPath
    ];

    console.log('Running ffmpeg with args:', ffArgs.join(' '));
    try {
      await runCommand('ffmpeg', ffArgs, { env: process.env });
    } catch (err) {
      console.error('ffmpeg failed:', err);
      throw new Error(`ffmpeg failed: ${err.stderr || err.error?.message || JSON.stringify(err)}`);
    }

    // verify output
    let outStats;
    try {
      outStats = await fsPromises.stat(outputPath);
    } catch (e) {
      throw new Error('ffmpeg did not produce an output file');
    }
    if (outStats.size === 0) throw new Error('ffmpeg produced empty output');

    console.log('Output size bytes:', outStats.size);

    // Stream file to client
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', 'attachment; filename="clip.mp4"');
    const readStream = fs.createReadStream(outputPath);
    readStream.on('end', async () => {
      // Cleanup
      try { await fsPromises.unlink(downloadPath).catch(()=>{}); } catch {}
      try { await fsPromises.unlink(outputPath).catch(()=>{}); } catch {}
      activeJobs = Math.max(0, activeJobs - 1);
      console.log('Successfully finished request and cleaned up.');
    });
    readStream.on('error', async (err) => {
      console.error('Read stream error:', err);
      activeJobs = Math.max(0, activeJobs - 1);
      res.destroy(err);
    });
    readStream.pipe(res);
  } catch (err) {
    activeJobs = Math.max(0, activeJobs - 1);
    console.error('Clip processing error:', err && (err.stack || err));
    const message = (err && err.message) ? err.message : String(err);
    // Be explicit: return textual failure with logs for easier debugging
    res.status(500).json({ error: 'Failed to process clip', message });
  }
});

// Health
app.get('/', (req, res) => res.json({ status: 'ok' }));

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`FFmpeg clip service listening on ${port}`);
});
