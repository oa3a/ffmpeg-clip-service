import express from "express";
import fetch from "node-fetch";
import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

const app = express();
app.use(express.json({ limit: "50mb" }));

app.get("/", (req, res) => {
  res.send("FFmpeg server is running");
});

app.post("/clip", async (req, res) => {
  try {
    const { vodUrl, startTime, endTime } = req.body;

    if (!vodUrl) {
      return res.status(400).json({ error: "vodUrl missing" });
    }

    console.log("FFMPEG RECEIVED:", vodUrl);

    const tmp = os.tmpdir();
    const inputPath = path.join(tmp, `input-${Date.now()}.m3u8`);
    const outputPath = path.join(tmp, `clip-${Date.now()}.mp4`);

    // Download playlist
    const playlistRes = await fetch(vodUrl);
    const playlistTxt = await playlistRes.text();

    if (!playlistRes.ok || !playlistTxt.includes("#EXTM3U")) {
      console.error("Invalid playlist:", playlistTxt.slice(0, 200));
      return res.status(400).json({
        error: "Invalid playlist",
        details: playlistTxt.slice(0, 500),
      });
    }

    fs.writeFileSync(inputPath, playlistTxt);

    // FFmpeg command
    const args = [
      "-protocol_whitelist",
      "file,http,https,tcp,tls",
      "-allowed_extensions",
      "ALL",
      "-ss",
      `${startTime}`,
      "-to",
      `${endTime}`,
      "-i",
      inputPath,
      "-c:v",
      "copy",
      "-c:a",
      "copy",
      "-y",
      outputPath,
    ];

    console.log("Running:", args.join(" "));

    const ff = spawn("ffmpeg", args);

    let stderr = "";

    ff.stderr.on("data", (d) => {
      stderr += d.toString();
    });

    ff.on("close", async (code) => {
      if (code !== 0) {
        console.error("FFMPEG ERROR:", stderr);
        return res.status(500).json({
          error: "FFmpeg failed",
          details: stderr,
        });
      }

      const mp4 = fs.readFileSync(outputPath);

      res.setHeader("Content-Type", "video/mp4");
      res.send(mp4);

      fs.unlinkSync(inputPath);
      fs.unlinkSync(outputPath);
    });
  } catch (err) {
    console.error("SERVER ERROR:", err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Running on port", PORT));
