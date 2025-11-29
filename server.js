const express = require("express");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { v4: uuidv4 } = require("uuid");

const app = express();
app.use(express.json({ limit: "100mb" }));

// Helper to run commands as Promise
function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args);
    let stderr = "";

    p.stderr.on("data", (d) => (stderr += d.toString()));
    p.on("close", (code) => {
      if (code !== 0) reject(stderr);
      else resolve();
    });
  });
}

app.post("/clip", async (req, res) => {
  const { vodUrl, startTime, endTime } = req.body;

  if (!vodUrl) {
    return res.status(400).json({ error: "vodUrl is required" });
  }

  console.log("Received:", vodUrl);

  const tmp = os.tmpdir();
  const downloadPath = path.join(tmp, `vod-${uuidv4()}.mp4`);
  const clipPath = path.join(tmp, `clip-${uuidv4()}.mp4`);

  try {
    // STEP 1 — Download VOD using yt-dlp
    console.log("Downloading VOD with yt-dlp...");
    await run("yt-dlp", [
      "-f", "best",
      vodUrl,
      "-o", downloadPath
    ]);

    console.log("Download complete:", downloadPath);

    if (!fs.existsSync(downloadPath)) {
      throw new Error("yt-dlp failed: file not created");
    }

    // STEP 2 — Trim with ffmpeg
    console.log("Trimming clip with ffmpeg...");

    await run("ffmpeg", [
      "-ss", startTime,
      "-to", endTime,
      "-i", downloadPath,
      "-c", "copy",
      "-y",
      clipPath
    ]);

    console.log("FFmpeg done:", clipPath);

    if (!fs.existsSync(clipPath)) {
      throw new Error("Clip not generated");
    }

    // STEP 3 — Send final MP4
    const mp4 = fs.readFileSync(clipPath);
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Disposition", "attachment; filename=clip.mp4");
    res.send(mp4);

  } catch (err) {
    console.error("Error:", err);
    return res.status(500).json({ error: "FFmpeg or yt-dlp failed", details: err });
  } finally {
    // Cleanup
    try { fs.unlinkSync(downloadPath); } catch {}
    try { fs.unlinkSync(clipPath); } catch {}
  }
});

app.listen(process.env.PORT || 3000, () =>
  console.log("FFmpeg service running")
);
