// ------------------------------
// RAILWAY FFMPEG CLIP SERVICE
// ------------------------------
import express from "express";
import cors from "cors";
import fs from "fs/promises";
import path from "path";
import fetch from "node-fetch";
import ffmpeg from "fluent-ffmpeg";
import ffmpegStatic from "ffmpeg-static";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Force ffmpeg path
ffmpeg.setFfmpegPath(ffmpegStatic);

const app = express();
app.use(cors());
app.use(express.json({ limit: "5mb" }));

// Health check
app.get("/", (req, res) => {
  res.json({ status: "OK - FFmpeg server running" });
});

// Helper: seconds or HH:MM:SS → seconds
function toSeconds(t) {
  if (typeof t === "number") return t;
  const parts = String(t).split(":").map(Number);

  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return Number(parts[0]) || 0;
}

app.post("/clip", async (req, res) => {
  try {
    const { vodUrl, startTime, endTime } = req.body;

    if (!vodUrl || !startTime || !endTime) {
      return res.status(400).json({ error: "vodUrl, startTime, endTime are required" });
    }

    if (!vodUrl.startsWith("http://") && !vodUrl.startsWith("https://")) {
      return res.status(400).json({ error: "vodUrl must be an absolute URL" });
    }

    console.log("Received clip request:", { vodUrl, startTime, endTime });

    // Paths
    const tmpDir = path.join(__dirname, "tmp");
    await fs.mkdir(tmpDir, { recursive: true });

    const outputPath = path.join(tmpDir, `clip-${Date.now()}.mp4`);

    const startSec = toSeconds(startTime);
    const endSec = toSeconds(endTime);
    const duration = endSec - startSec;

    console.log("Parsed duration:", duration, "seconds");

    // FFmpeg command
    await new Promise((resolve, reject) => {
      const cmd = ffmpeg(vodUrl)
        .inputOptions([
          "-protocol_whitelist", "file,http,https,tcp,tls",
          "-allowed_extensions", "ALL"
        ])
        .setStartTime(startSec)
        .setDuration(duration)
        .outputOptions([
          "-c:v copy",
          "-c:a copy",
          "-avoid_negative_ts make_zero"
        ])
        .output(outputPath)
        .on("start", (cmd) => console.log("FFmpeg:", cmd))
        .on("end", resolve)
        .on("error", reject)
        .run();
    });

    // Read output file
    const mp4 = await fs.readFile(outputPath);

    if (!mp4 || mp4.length < 2000) {
      return res.status(500).json({ error: "Generated MP4 is empty or invalid" });
    }

    console.log("Sending MP4, size:", mp4.length);

    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Disposition", "attachment; filename=clip.mp4");
    res.send(mp4);

    await fs.unlink(outputPath).catch(() => {});
  } catch (err) {
    console.error("Clip processing error:", err);
    res.status(500).json({
      error: "FFmpeg failed",
      details: err.message ?? String(err)
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("FFmpeg server running on port", PORT));
