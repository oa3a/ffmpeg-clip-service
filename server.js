import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import ffmpeg from "fluent-ffmpeg";
import ffmpegStatic from "ffmpeg-static";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

ffmpeg.setFfmpegPath(ffmpegStatic);

const app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" }));

// Health check
app.get("/", (req, res) => {
  res.send("FFmpeg service OK");
});

// Convert HH:MM:SS to seconds
function toSeconds(t) {
  if (typeof t === "number") return t;
  const parts = t.split(":").map(Number);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return Number(t);
}

app.post("/clip", async (req, res) => {
  const { vodUrl, startTime, endTime } = req.body;

  if (!vodUrl) return res.status(400).json({ error: "vodUrl missing" });

  console.log("📩 Received clip request:", { vodUrl, startTime, endTime });

  const tempDir = path.join(__dirname, "temp");
  await fs.mkdir(tempDir, { recursive: true });

  const outPath = path.join(tempDir, `clip-${Date.now()}.mp4`);

  try {
    if (!vodUrl.startsWith("http")) {
      return res.status(400).json({ error: "vodUrl must be absolute HTTP URL" });
    }

    console.log("🎥 Using FFmpeg directly on m3u8:", vodUrl);

    const duration = toSeconds(endTime) - toSeconds(startTime);

    await new Promise((resolve, reject) => {
      ffmpeg(vodUrl)
        .setStartTime(startTime)
        .setDuration(duration)
        .inputOptions(["-protocol_whitelist", "file,http,https,tcp,tls"])
        .outputOptions(["-c copy"])
        .on("start", (cmd) => console.log("FFmpeg:", cmd))
        .on("progress", (info) => console.log("FFmpeg progress:", info))
        .on("error", (err) => reject(err))
        .on("end", () => resolve())
        .save(outPath);
    });

    const buffer = await fs.readFile(outPath);
    await fs.unlink(outPath).catch(() => {});

    console.log("✅ Sending clipped MP4:", buffer.length, "bytes");

    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Disposition", "attachment; filename=clip.mp4");
    return res.send(buffer);
  } catch (err) {
    console.error("❌ FFmpeg Error:", err);

    return res.status(500).json({
      error: "FFmpeg failed",
      details: err.message,
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("🚀 Railway FFmpeg service running on", PORT));
