const express = require("express");
const multer = require("multer");
const fetch = require("node-fetch");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { v4: uuidv4 } = require("uuid");

const upload = multer({ storage: multer.memoryStorage() });
const app = express();
app.use(express.json({ limit: "500mb" }));

app.post("/clip", upload.single("file"), async (req, res) => {
  try {
    const startTime = req.body.startTime || "00:00:00";
    const endTime = req.body.endTime || "00:00:10";

    const tmpDir = os.tmpdir();
    const inputName = `input-${uuidv4()}.mp4`;
    const inputPath = path.join(tmpDir, inputName);

    if (req.file && req.file.buffer) {
      fs.writeFileSync(inputPath, req.file.buffer);
    } else if (req.body.vodUrl) {
      const resp = await fetch(req.body.vodUrl);
      if (!resp.ok) return res.status(400).json({ error: "Cannot fetch vodUrl" });
      const buffer = await resp.buffer();
      fs.writeFileSync(inputPath, buffer);
    } else {
      return res.status(400).json({ error: "No file or vodUrl provided" });
    }

    const outputName = `out-${uuidv4()}.mp4`;
    const outputPath = path.join(tmpDir, outputName);

    const args = ["-ss", startTime, "-to", endTime, "-i", inputPath, "-c", "copy", "-y", outputPath];
    const ff = spawn("ffmpeg", args);

    ff.on("close", () => {
      const stream = fs.createReadStream(outputPath);
      res.setHeader("Content-Type", "video/mp4");
      res.setHeader("Content-Disposition", "attachment; filename=clip.mp4");
      stream.pipe(res);

      stream.on("end", () => {
        fs.unlinkSync(inputPath);
        fs.unlinkSync(outputPath);
      });
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.get("/", (req, res) => res.send("FFmpeg service running"));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("Running on port", port));
