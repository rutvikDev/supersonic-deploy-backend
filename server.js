const express = require("express");
const multer = require("multer");
const admZip = require("adm-zip");
const fs = require("fs-extra");
const path = require("path");
const dotenv = require("dotenv");
const axios = require("axios");
const cors = require("cors");
const crypto = require("crypto");

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;
const VERCEL_TOKEN = process.env.VERCEL_TOKEN;

app.use(cors());
app.use(express.json());

// Set up multer for temporary file uploads
const upload = multer({ dest: "uploads/" });

// Utility to generate random suffix
const generateSuffix = () => crypto.randomBytes(3).toString("hex");

// Read directory recursively
async function getAllFiles(dirPath, arrayOfFiles) {
  const files = await fs.readdir(dirPath);

  arrayOfFiles = arrayOfFiles || [];

  for (const file of files) {
    // Ignore macos artifacts and node_modules just in case
    if (file === "__MACOSX" || file === ".DS_Store" || file === "node_modules") continue;

    const fullPath = path.join(dirPath, file);
    if ((await fs.stat(fullPath)).isDirectory()) {
      arrayOfFiles = await getAllFiles(fullPath, arrayOfFiles);
    } else {
      arrayOfFiles.push(fullPath);
    }
  }

  return arrayOfFiles;
}

app.post("/deploy", upload.single("file"), async (req, res) => {
  let extractPath = "";
  try {
    const { framework, customName } = req.body;
    const file = req.file;

    if (!file) {
      return res.status(400).json({ status: "error", message: "No zip file provided" });
    }
    if (!VERCEL_TOKEN) {
      return res.status(500).json({ status: "error", message: "VERCEL_TOKEN missing on server" });
    }

    const projectName = customName || `deploy-${generateSuffix()}`;
    // Sanitize name
    if (!/^[a-z0-9-]+$/.test(projectName)) {
      return res.status(400).json({ status: "error", message: "Invalid custom name format" });
    }

    const zipPath = file.path;
    extractPath = path.join(__dirname, "temp", file.filename);

    // 1. Extract ZIP
    console.log(`Extracting zip to ${extractPath}...`);
    const zip = new admZip(zipPath);
    // Be careful with zip bombs or massive zips, but assuming standard project sizes for now
    zip.extractAllTo(extractPath, true);

    // Some zips have a root folder encapsulating the project. Let's find where package.json is.
    let projectRoot = extractPath;
    const rootFiles = await fs.readdir(extractPath);
    if (!rootFiles.includes("package.json") && rootFiles.length === 1) {
      const possibleRoot = path.join(extractPath, rootFiles[0]);
      const stat = await fs.stat(possibleRoot);
      if (stat.isDirectory()) {
        const subFiles = await fs.readdir(possibleRoot);
        if (subFiles.includes("package.json")) {
          projectRoot = possibleRoot;
        }
      }
    }

    // 2. Validate Project
    const packageJsonPath = path.join(projectRoot, "package.json");
    if (!(await fs.pathExists(packageJsonPath))) {
      return res.status(400).json({ status: "error", message: "Missing package.json in project root" });
    }

    const nodeModulesPath = path.join(projectRoot, "node_modules");
    if (await fs.pathExists(nodeModulesPath)) {
      return res.status(400).json({ status: "error", message: "node_modules folder is present. Please remove before zipping." });
    }

    const packageJsonContent = await fs.readJson(packageJsonPath);
    const scripts = packageJsonContent.scripts || {};
    if (!scripts.build) {
      return res.status(400).json({ status: "error", message: "Build failed: missing build script in package.json" });
    }
    if (!scripts.start && !scripts.dev) {
      return res.status(400).json({ status: "error", message: "Build failed: missing start or dev script in package.json" });
    }

    // Attempt auto-detect if not provided
    let detectedFramework = framework;
    if (!detectedFramework) {
      const deps = { ...packageJsonContent.dependencies, ...packageJsonContent.devDependencies };
      if (deps["next"]) detectedFramework = "nextjs";
      else if (deps["vite"]) detectedFramework = "vite";
      else if (deps["react-scripts"]) detectedFramework = "create-react-app";
    }

    // 3. Process files for Vercel Deploy API
    console.log("Calculating file hashes and preparing payload...");
    const allFilePaths = await getAllFiles(projectRoot);

    const displayFiles = [];

    // Upload files to Vercel one by one using /v2/files
    // In production we should batch requests or limit concurrency
    for (const filePath of allFilePaths) {
      const content = await fs.readFile(filePath);
      const sha1 = crypto.createHash("sha1").update(content).digest("hex");
      const size = content.length;

      const relativePath = path.relative(projectRoot, filePath).replace(/\\/g, "/");

      try {
        await axios.post("https://api.vercel.com/v2/files", content, {
          headers: {
            Authorization: `Bearer ${VERCEL_TOKEN}`,
            "x-vercel-digest": sha1,
            "Content-Length": size,
            "Content-Type": "application/octet-stream",
          },
        });
      } catch (err) {
        // Vercel might return 400 if it already has the file, but typically it just accepts it.
        // Actually, if it already has it, it might still return 200 via different headers. We proceed unless it's a hard error.
        console.error(`Failed to upload ${relativePath}:`, err.response?.data || err.message);
        throw new Error(`Failed to upload file ${relativePath}`);
      }

      displayFiles.push({
        file: relativePath,
        sha: sha1,
        size: size,
      });
    }

    // 4. Trigger Deployment
    console.log("Triggering Vercel deployment...", projectName);

    let vercelFrameworkSetting = null;
    if (detectedFramework === "nextjs") vercelFrameworkSetting = "nextjs";
    else if (detectedFramework === "vite") vercelFrameworkSetting = "vite";
    else if (detectedFramework === "create-react-app" || detectedFramework === "react") vercelFrameworkSetting = "create-react-app";

    const deployPayload = {
      name: projectName,
      files: displayFiles,
      projectSettings: {
        framework: vercelFrameworkSetting,
      },
    };

    const deployRes = await axios.post("https://api.vercel.com/v13/deployments", deployPayload, {
      headers: {
        Authorization: `Bearer ${VERCEL_TOKEN}`,
        "Content-Type": "application/json",
      },
    });

    const deploymentUrl = deployRes.data.url ? `https://${deployRes.data.url}` : null;

    if (!deploymentUrl) {
      throw new Error("Vercel did not return a valid URL");
    }

    const url = new URL(deploymentUrl);
    const parts = url.hostname.split("-");

    // take everything except last 3 parts (random + username + projects)
    const base = parts.slice(0, -3).join("-");

    const result = `https://${base}.vercel.app/`;

    // Success response
    res.json({
      status: "success",
      url: result,
      deploymentId: deployRes.data.id,
    });

    // 5. Cleanup
    try {
      await fs.remove(file.path);
      await fs.remove(extractPath);
    } catch (cleanupErr) {
      console.error("Cleanup error:", cleanupErr);
    }
  } catch (error) {
    console.error("Deploy error:", error.response?.data || error.message);

    // Ensure cleanup even on error
    if (req.file && (await fs.pathExists(req.file.path))) await fs.remove(req.file.path);
    if (extractPath && (await fs.pathExists(extractPath))) await fs.remove(extractPath);

    res.status(500).json({
      status: "error",
      message: error.response?.data?.error?.message || error.message || "Deployment failed",
    });
  }
});

app.listen(PORT, () => {
  console.log(`Backend server running on http://localhost:${PORT}`);
});
