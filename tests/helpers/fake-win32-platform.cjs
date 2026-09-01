// Test-only preload for native-Windows installer/uninstaller control flow.
Object.defineProperty(process, "platform", {
  configurable: true,
  enumerable: true,
  value: "win32",
});
