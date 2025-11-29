import express from 'express';
import cors from 'cors';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegStatic from 'ffmpeg-static';
import { exec } from 'child_process';
import { promisify } from 'util';
import fetch from 'node-fetch';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const execAsync = promisify(exec);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Set FFmpeg path
ffmpeg.setFfmpegPath(ffmpegStatic);

// Middleware
app.use(cors());
app.use(express.json());

// Health check
app.get('/', (req, res) => {
  res.json({
    status: 'Railway FFmpeg Service Running',
    version: '1.0.0',
    endpoints: ['/clip']
  });
});

// Clip endpoint
app.post('/clip', async (req, res) => {
  const tempDir = path.join(__dirname, 'temp');
  const inputPath = path.join(tempDir, `input-${Date.now()}.mp4`);
  const outputPath = path.join(tempDir, `output-${Date.now()}.mp4`);

  try {
    const { vodUrl, startTime, endTime } = req.body;

    if (!vodUrl || startTime == null || endTime == null) {
      return res.status(400).json({
        error: 'Missing required fields: vodUrl, startTime, endTime'
      });
    }

    console.log('Railway: received vodUrl clip request', { vodUrl, startTime, endTime });

    // CRITICAL: Validate vodUrl is absolute
    if (typeof vodUrl !== 'string' || (!vodUrl.startsWith('http://') && !vodUrl.startsWith('https://'))) {
      console.error('Invalid vodUrl (not absolute):', vodUrl);
      return res.status(400).json({
        error: 'vodUrl must be an absolute URL starting with http:// or https://',
        received: vodUrl
      });
    }

    console.log('Validated absolute vodUrl:', vodUrl);

    // Ensure temp directory exists
    await fs.mkdir(tempDir, { recursive: true });

    // Check if vodUrl is an m3u8 playlist (HLS stream)
    const isM3U8 = vodUrl.includes('.m3u8');

    if (isM3U8) {
      console.log('Detected m3u8 playlist, will stream directly to FFmpeg');
      console.log('Running FFmpeg with direct m3u8 URL');

      await new Promise((resolve, reject) => {
        const command = ffmpeg(vodUrl)
          .setStartTime(startTime)
          .setDuration(calculateDuration(startTime, endTime))
          .inputOptions([
            '-protocol_whitelist', 'file,http,https,tcp,tls'
          ])
          .outputOptions([
            '-c copy',
            '-avoid_negative_ts', 'make_zero'
          ])
          .output(outputPath)
          .on('start', (cmd) => {
            console.log('FFmpeg command:', cmd);
          })
          .on('progress', (progress) => {
            console.log('Processing:', progress.percent ? `${progress.percent.toFixed(2)}%` : 'in progress');
          })
          .on('end', () => {
            console.log('FFmpeg processing complete');
            resolve();
          })
          .on('error', (err) => {
            console.error('FFmpeg error:', err);
            reject(err);
          });

        command.run();
      });
    } else {
      // For regular video files, download first
      console.log('Downloading video file from:', vodUrl);

      try {
        const vodResponse = await fetch(vodUrl, {
          redirect: 'follow'
        });

        if (!vodResponse.ok) {
          console.error('Failed to fetch VOD:', vodUrl, vodResponse.status, vodResponse.statusText);
          return res.status(400).json({
            error: 'Cannot fetch vodUrl',
            details: `HTTP ${vodResponse.status}: ${vodResponse.statusText}`,
            vodUrl
          });
        }

        const vodBuffer = await vodResponse.arrayBuffer();
        await fs.writeFile(inputPath, Buffer.from(vodBuffer));
        console.log('VOD downloaded successfully, size:', vodBuffer.byteLength, 'bytes');

        // Verify downloaded file
        const stats = await fs.stat(inputPath);
        console.log('Input file stats:', { size: stats.size, path: inputPath });

        // Run FFmpeg to trim video
        console.log('Running FFmpeg trim:', { startTime, endTime });

        await new Promise((resolve, reject) => {
          ffmpeg(inputPath)
            .setStartTime(startTime)
            .setDuration(calculateDuration(startTime, endTime))
            .outputOptions([
              '-c copy',
              '-avoid_negative_ts', 'make_zero'
            ])
            .output(outputPath)
            .on('start', (cmd) => {
              console.log('FFmpeg command:', cmd);
            })
            .on('progress', (progress) => {
              console.log('Processing:', progress.percent ? `${progress.percent.toFixed(2)}%` : 'in progress');
            })
            .on('end', () => {
              console.log('FFmpeg processing complete');
              resolve();
            })
            .on('error', (err) => {
              console.error('FFmpeg error:', err);
              reject(err);
            })
            .run();
        });
      } catch (fetchError) {
        console.error('Failed to fetch VOD:', vodUrl, fetchError);
        return res.status(400).json({
          error: 'Cannot fetch vodUrl',
          details: fetchError.message,
          vodUrl
        });
      }
    }

    // Read output file
    const outputBuffer = await fs.readFile(outputPath);
    console.log('Output file size:', outputBuffer.length, 'bytes');

    if (outputBuffer.length === 0) {
      throw new Error('FFmpeg produced empty output file');
    }

    // Verify MP4 header
    const header = outputBuffer.slice(0, 12);
    const headerHex = Array.from(header).map(b => b.toString(16).padStart(2, '0')).join(' ');
    console.log('Output MP4 header:', headerHex);

    // Clean up temp files
    await fs.unlink(inputPath).catch(err => console.warn('Failed to delete input:', err));
    await fs.unlink(outputPath).catch(err => console.warn('Failed to delete output:', err));

    // Send MP4 back to client
    res.set({
      'Content-Type': 'video/mp4',
      'Content-Disposition': 'attachment; filename="clip.mp4"',
      'Content-Length': outputBuffer.length
    });
    res.send(outputBuffer);

    console.log('Successfully sent MP4 to client');

  } catch (error) {
    console.error('Clip processing error:', error);

    // Clean up on error
    try {
      await fs.unlink(inputPath).catch(() => {});
      await fs.unlink(outputPath).catch(() => {});
    } catch (cleanupError) {
      console.warn('Cleanup error:', cleanupError);
    }

    res.status(500).json({
      error: 'Failed to process clip',
      message: error.message,
      type: error.constructor?.name ?? 'Error'
    });
  }
});

// Helper: Calculate duration from start and end time
function calculateDuration(startTime, endTime) {
  const start = parseTimeToSeconds(startTime);
  const end = parseTimeToSeconds(endTime);
  const duration = end - start;
  console.log('Calculated duration:', { start, end, duration });
  return duration;
}

// Helper: Convert HH:MM:SS or seconds to seconds
function parseTimeToSeconds(time) {
  if (typeof time === 'number' && Number.isFinite(time)) {
    return time;
  }

  const str = String(time);
  const parts = str.split(':').map(Number);

  if (parts.length === 3) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  } else if (parts.length === 2) {
    return parts[0] * 60 + parts[1];
  } else {
    return parts[0];
  }
}

async function logYtDlpVersion() {
  try {
    const { stdout } = await execAsync('yt-dlp --version');
    console.log('yt-dlp available, version:', stdout.trim());
  } catch (err) {
    console.warn('yt-dlp not found in PATH. Some sources may not work.', err?.message ?? err);
  }
}

app.listen(PORT, () => {
  console.log(`Railway FFmpeg Service listening on port ${PORT}`);
  console.log(`FFmpeg path: ${ffmpegStatic}`);
  logYtDlpVersion().catch(() => {});
});
