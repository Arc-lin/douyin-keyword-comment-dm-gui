import os from "node:os";
import { spawn } from "node:child_process";

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(stderr.trim() || `${command} 退出码 ${code}`));
    });
  });
}

async function pickOnMac() {
  let appPath;
  try {
    appPath = await run("osascript", [
      "-e",
      'POSIX path of (choose application with prompt "选择 Chrome 或 Edge")'
    ]);
  } catch (error) {
    if (/User canceled|-128/.test(error.message)) return "";
    throw new Error(`调起系统选择器失败：${error.message}`);
  }
  appPath = appPath.replace(/\/$/, "");
  const executableName = await run("defaults", [
    "read",
    `${appPath}/Contents/Info`,
    "CFBundleExecutable"
  ]).catch(() => "");
  if (!executableName) {
    throw new Error("无法识别所选应用的可执行文件，请改用下方输入框手动填写路径。");
  }
  return `${appPath}/Contents/MacOS/${executableName}`;
}

async function pickOnWindows() {
  const script =
    "Add-Type -AssemblyName System.Windows.Forms; " +
    "$f = New-Object System.Windows.Forms.OpenFileDialog; " +
    "$f.Filter = 'Executable (*.exe)|*.exe'; " +
    "if ($f.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $f.FileName }";
  try {
    return await run("powershell", ["-NoProfile", "-Command", script]);
  } catch (error) {
    throw new Error(`调起系统选择器失败：${error.message}`);
  }
}

async function pickOnLinux() {
  try {
    return await run("zenity", ["--file-selection", "--title=选择 Chrome 或 Edge 可执行文件"]);
  } catch (zenityError) {
    if (/User canceled|cancel/i.test(zenityError.message)) return "";
    try {
      return await run("kdialog", ["--getopenfilename"]);
    } catch (kdialogError) {
      if (/User canceled|cancel/i.test(kdialogError.message)) return "";
      throw new Error(
        "未找到系统文件选择器（zenity/kdialog），请改用下方输入框手动填写路径。"
      );
    }
  }
}

export async function pickBrowserPath() {
  const platform = os.platform();
  if (platform === "darwin") return pickOnMac();
  if (platform === "win32") return pickOnWindows();
  return pickOnLinux();
}
