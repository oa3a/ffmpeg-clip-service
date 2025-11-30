import express from "express";
import cors from "cors";
import ffmpeg from "fluent-ffmpeg";
import ffmpegStatic from "ffmpeg-static";
import fetch from "node-fetch";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Ensure ffmpeg path is set
ffmpeg.setFfmpegPath(ffmpegStatic);

app.use(cors());
app.use(express.json());

// Health check endpoint
app.get("/", (req, res) => {
  res.json({
    status: "Railway FFmpeg Service Running",
    version: "1.0.0",
    endpoints: ["/clip"],
  });
});

// Clip endpoint
app.post("/clip", async (req, res) => {
  const tempDir = path.join(__dirname, "temp");
  await fs.mkdir(tempDir, { recursive: true });

  const inputPath = path.join(tempDir, `input-${Date.now()}.mp4`);
  const outputPath = path.join(tempDir, `output-${Date.now()}.mp4`);

  try {
    const { vodUrl, startTime, endTime } = req.body;

    if (!vodUrl || startTime == null || endTime == null) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    console.log("Received clip job:", { vodUrl, startTime, endTime });

    // Detect if playlist
    const isM3U8 = vodUrl.endsWith(".m3u8");

    if (isM3U8) {
      console.log("Processing m3u8 stream directly with FFmpeg");

      await new Promise((resolve, reject) => {
        ffmpeg(vodUrl)
          .setStartTime(startTime)
          .setDuration(endTime - startTime)
          .inputOptions(["-protocol_whitelist", "file,http,https,tcp,tls"])
          .outputOptions(["-c copy", "-avoid_negative_ts make_zero"])
          .output(outputPath)
          .on("end", resolve)
          .on("error", reject)
          .run();
      });
    } else {
      console.log("Downloading full MP4 first…");

      const vodRes = await fetch(vodUrl);
      if (!vodRes.ok) {
        return res.status(400).json({ error: "Failed to fetch vodUrl" });
      }

      const vodBuffer = Buffer.from(await vodRes.arrayBuffer());
      await fs.writeFile(inputPath, vodBuffer);

      console.log("Running FFmpeg trim…");

      await new Promise((resolve, reject) => {
        ffmpeg(inputPath)
          .setStartTime(startTime)
          .setDuration(endTime - startTime)
          .outputOptions(["-c copy", "-avoid_negative_ts make_zero"])
          .output(outputPath)
          .on("end", resolve)
          .on("error", reject)
          .run();
      });
    }

    const outputBuffer = await fs.readFile(outputPath);

    res.set({
      "Content-Type": "video/mp4",
      "Content-Length": outputBuffer.length,
      "Content-Disposition": 'attachment; filename="clip.mp4"',
    });

    res.send(outputBuffer);

    await fs.unlink(inputPath).catch(() => {});
    await fs.unlink(outputPath).catch(() => {});
  } catch (err) {
    console.error("Processing error", err);

    res.status(500).json({
      error: "FFmpeg failed",
      details: err.message,
    });
  }
});

app.listen(PORT, () => {
  console.log(`FFmpeg Clip Service running on port ${PORT}`);
});
