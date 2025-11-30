import express from "express";
import cors from "cors";
import ffmpeg from "fluent-ffmpeg";
import { exec } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import path from "path";
import fetch from "node-fetch";

const execAsync = promisify(exec);
const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => {
  res.json({ status: "running", yt_dlp: "ok", ffmpeg: "ok" });
});

app.post("/clip", async (req, res) => {
  try {
    const { vodUrl, startTime, endTime } = req.body;

    if (!vodUrl) return res.status(400).json({ error: "vodUrl required" });

    const temp = "/tmp";
    const output = `${temp}/clip-${Date.now()}.mp4`;

    console.log("Clipping:", vodUrl, startTime, endTime);

    const duration = endTime - startTime;

    await new Promise((resolve, reject) => {
      ffmpeg(vodUrl)
        .setStartTime(startTime)
        .setDuration(duration)
        .inputOptions([
          "-protocol_whitelist", "file,http,https,tcp,tls",
          "-reconnect", "1",
          "-reconnect_streamed", "1",
          "-reconnect_delay_max", "5"
        ])
        .outputOptions(["-c copy"])
        .on("error", (err) => reject(err))
        .on("end", resolve)
        .save(output);
    });

    const buffer = await fs.readFile(output);

    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Disposition", "attachment; filename=clip.mp4");
    return res.send(buffer);
  } catch (err) {
    console.error("FFmpeg failed", err);
    return res.status(500).json({ error: "FFmpeg failed", details: err.message });
  }
});

app.listen(PORT, () => {
  console.log("Railway FFmpeg service running on port", PORT);
})
