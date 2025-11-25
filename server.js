const express = require("express");
const fetch = require("node-fetch");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { v4: uuidv4 } = require("uuid");

const app = express();
app.use(express.json({ limit: "100mb" }));

app.post("/clip", async (req, res) => {
  try {
    const { vodUrl, startTime, endTime } = req.body;

    if (!vodUrl) {
      return res.status(400).json({ error: "vodUrl missing" });
    }

    console.log("Railway: received vodUrl:", vodUrl);

    if (!vodUrl.startsWith("http")) {
      return res.status(400).json({ error: "vodUrl must be absolute" });
    }

    const tmp = os.tmpdir();
    const inputPath = path.join(tmp, `vod-${uuidv4()}.m3u8`);
    const outputPath = path.join(tmp, `clip-${uuidv4()}.mp4`);

    console.log("Railway: downloading m3u8…");
    const playlist = await fetch(vodUrl);
    if (!playlist.ok) {
      const txt = await playlist.text();
      return res.status(400).json({ error: "Cannot download playlist", details: txt });
    }

    const playlistData = await playlist.text();
    fs.writeFileSync(inputPath, playlistData);

    console.log("Railway: saved m3u8 playlist");

    const args = [
      "-protocol_whitelist", "file,http,https,tcp,tls",
      "-allowed_extensions", "ALL",
      "-ss", startTime,
      "-to", endTime,
      "-i", inputPath,
      "-c:v", "copy",
      "-c:a", "copy",
      "-y",
      outputPath
    ];

    console.log("Railway: running ffmpeg:", args.join(" "));

    const ff = spawn("ffmpeg", args);

    let ffError = "";
    ff.stderr.on("data", (d) => (ffError += d.toString()));

    ff.on("close", async (code) => {
      console.log("Railway: ffmpeg finished:", code);
      if (code !== 0) {
        return res.status(500).json({ error: "FFmpeg failed", details: ffError });
      }

      if (!fs.existsSync(outputPath)) {
        return res.status(500).json({ error: "Output file missing" });
      }

      const mp4 = fs.readFileSync(outputPath);

      res.setHeader("Content-Type", "video/mp4");
      res.setHeader("Content-Disposition", `attachment; filename=clip.mp4`);
      res.send(mp4);

      fs.unlinkSync(inputPath);
      fs.unlinkSync(outputPath);
    });

  } catch (err) {
    console.error("Railway fatal error:", err);
    res.status(500).json({ error: String(err) });
  }
});

app.get("/", (req, res) => res.send("FFmpeg service OK"));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("FFmpeg running on port", port));
