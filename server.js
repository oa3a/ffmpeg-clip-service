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

ffmpeg.setFfmpegPath(ffmpegStatic);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: "10mb" })); // edge function sends small JSON

// Health check
app.get("/", (req, res) => {
  res.json({
    status: "Railway FFmpeg service running",
    ok: true,
    version: "2.0.0",
  });
});

// Convert HH:MM:SS or seconds → seconds
function parseTime(time) {
  if (typeof time === "number") return time;

  const str = String(time);
  if (str.includes(":")) {
    const [h, m, s] = str.split(":").map(Number);
    return h * 3600 + m * 60 + s;
  }
  return Number(str);
}

function durationBetween(start, end) {
  return parseTime(end) - parseTime(start);
}

app.post("/clip", async (req, res) => {
  const { vodUrl, startTime, endTime } = req.body;

  console.log("RAILWAY /clip received:", {
    vodUrl,
    startTime,
    endTime
  });

  // Validate inputs
  if (!vodUrl || !vodUrl.startsWith("http")) {
    return res.status(400).json({
      error: "vodUrl must be an absolute URL",
      received: vodUrl,
    });
  }
  if (startTime == null || endTime == null) {
    return res.status(400).json({
      error: "startTime and endTime are required",
    });
  }

  const tempDir = path.join(__dirname, "temp");
  await fs.mkdir(tempDir, { recursive: true });

  const inputPath = path.join(tempDir, "input-" + Date.now() + ".mp4");
  const outputPath = path.join(tempDir, "output-" + Date.now() + ".mp4");

  const isM3U8 = vodUrl.includes(".m3u8");

  try {
    // ---------------------------------------------------------
    // CASE 1 — Twitch HLS Stream (.m3u8)
    // ---------------------------------------------------------
    if (isM3U8) {
      console.log("Processing as HLS stream (m3u8)…");

      await new Promise((resolve, reject) => {
        ffmpeg(vodUrl)
          .inputOptions([
            "-protocol_whitelist", "file,http,https,tcp,tls"
          ])
          .setStartTime(parseTime(startTime))
          .duration(durationBetween(startTime, endTime))
          .outputOptions([
            "-c:v", "copy",
            "-c:a", "copy",
            "-avoid_negative_ts", "make_zero",
          ])
          .output(outputPath)
          .on("start", (cmd) => console.log("FFmpeg command:", cmd))
          .on("progress", (p) =>
            console.log("FFmpeg progress:", p.percent?.toFixed(2) + "%")
          )
          .on("end", resolve)
          .on("error", reject)
          .run();
      });
    }

    // ---------------------------------------------------------
    // CASE 2 — direct MP4 URL (rare)
    // ---------------------------------------------------------
    else {
      console.log("Downloading direct MP4:", vodUrl);

      const vres = await fetch(vodUrl);
      if (!vres.ok) {
        throw new Error("Unable to download file: " + vres.status);
      }

      const buf = Buffer.from(await vres.arrayBuffer());
      await fs.writeFile(inputPath, buf);

      await new Promise((resolve, reject) => {
        ffmpeg(inputPath)
          .setStartTime(parseTime(startTime))
          .duration(durationBetween(startTime, endTime))
          .outputOptions(["-c copy"])
          .output(outputPath)
          .on("start", (cmd) => console.log("FFmpeg:", cmd))
          .on("progress", (p) =>
            console.log("FFmpeg progress:", p.percent?.toFixed(2) + "%")
          )
          .on("end", resolve)
          .on("error", reject)
          .run();
      });
    }

    // ---------------------------------------------------------
    // SEND OUTPUT FILE
    // ---------------------------------------------------------
    const output = await fs.readFile(outputPath);

    console.log("Sending MP4 bytes:", output.length);

    if (!output.length) {
      throw new Error("FFmpeg output is empty");
    }

    res.setHeader("Content-Type", "video/mp4");
    res.setHeader(
      "Content-Disposition",
      'attachment; filename="clip.mp4"'
    );
    return res.send(output);

  } catch (err) {
    console.error("FFmpeg ERROR:", err);
    return res.status(500).json({
      error: "FFmpeg failed",
      message: err.message,
    });
  } finally {
    // Cleanup
    try {
      await fs.unlink(inputPath).catch(() => {});
      await fs.unlink(outputPath).catch(() => {});
    } catch {}
  }
});

app.listen(PORT, () => {
  console.log("Railway FFmpeg service listening on", PORT);
  console.log("FFmpeg path:", ffmpegStatic);
});
