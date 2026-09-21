import { readFileSync } from "node:fs";

const requiredText = new Map([
  [
    "ios/App/CapApp-SPM/Package.swift",
    ["CapacitorApp", "CapacitorBrowser"],
  ],
  [
    "ios/App/App/capacitor.config.json",
    ['"AppPlugin"', '"CAPBrowserPlugin"'],
  ],
  [
    "ios/App/App/Info.plist",
    ["CFBundleURLTypes", "radar"],
  ],
]);

const missing = [];
for (const [path, needles] of requiredText) {
  const content = readFileSync(path, "utf8");
  for (const needle of needles) {
    if (!content.includes(needle)) missing.push(`${path}: ${needle}`);
  }
}

if (missing.length > 0) {
  console.error("iOS Google sign-in is not fully synchronized:");
  for (const item of missing) console.error(`- missing ${item}`);
  console.error("Run `npx cap sync ios` before opening Xcode or archiving.");
  process.exit(1);
}

console.log("iOS Google sign-in check passed: Browser, App, and radar:// are registered.");