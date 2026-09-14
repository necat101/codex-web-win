# Windows setup guide

Codex ChatGPT Web supports Windows x64 and Windows ARM64. The recommended installation is the
per-user offline setup executable from the project release. It does not require administrator
access and it deliberately does not install a Windows service, Scheduled Task, Run key, Startup
entry, or other boot/login persistence.

## Install from a release

Download the setup executable that matches the Windows architecture:

- `codex-chatgpt-web-windows-x64-setup.exe` for Intel/AMD Windows.
- `codex-chatgpt-web-windows-arm64-setup.exe` for Windows ARM64.

Double-click the setup executable, choose **Install**, and leave **Launch Codex ChatGPT Web now**
checked. The installer creates a per-user Start Menu shortcut, an optional Desktop shortcut, an
Apps & Features uninstall entry, and the user PATH entry used by the command-line launcher.

In the native Windows control center, complete browser-only setup, sign in through the dedicated
Chrome window, close that Chrome window completely, and choose **Start session**. Keep the control
center open while using the ChatGPT Web models. Closing it stops the foreground session and its
controlled browser. Start it again after signing in to Windows or rebooting.

Release downloads include `checksums.txt`. To verify a downloaded setup executable in PowerShell:

```powershell
Get-FileHash -Algorithm SHA256 .\codex-chatgpt-web-windows-x64-setup.exe
```

Compare the resulting SHA-256 value with the matching entry in `checksums.txt` before running the
installer.

## Build the Windows package from source

The Windows release build requires Bun 1.3.11, the built-in .NET Framework C# compiler, and network
access on the first build. The build downloads and checksum-verifies a pinned portable Go toolchain
and the exact tunnel-client v0.0.12 source tag, runs the no-expiry patch regressions, and caches the
reproducible patched binary. End-user setup remains offline. From a PowerShell prompt at the
repository root:

```powershell
bun install --frozen-lockfile
bun run verify
bun run package:windows
```

`package:windows` performs the runtime build, relocatable runtime smoke test, native GUI/Job Object
smoke tests, offline installer build, fresh-install smoke test, and upgrade smoke test. The final
installer is written under `dist` using the current architecture, for example:

```text
dist\codex-chatgpt-web-windows-x64-setup.exe
```

For a local installation of the freshly built runtime without using the offline setup executable:

```powershell
bun run build:windows
bun run install:windows
```

The local installer consumes `dist\runtime` and the repository's license/setup documents.

## Advanced PowerShell installation

`scripts\install.ps1` installs either a local runtime bundle or the matching release archive. Its
default per-user locations are under `%LOCALAPPDATA%\Programs\codex-chatgpt-web`; private browser
and configuration state lives under `%USERPROFILE%\.codex-chatgpt-web`.

To install the local bundle explicitly:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1 `
  -LocalBundle .\dist\runtime
```

Useful installer switches include `-NoPath`, `-NoDesktopShortcut`, `-NoShortcuts`, and
`-NoUninstallRegistration`. `-SetupArgs` can pass setup arguments to the installed launcher after
installation.

## Browser-only setup

Browser-only mode requires Chrome and a ChatGPT account. It does not require an API key, tunnel,
OpenCodex, or a Playwright browser download. The control center is the normal Windows session
owner; the command-line `session` command is an advanced alternative.

Useful diagnostics are:

```powershell
codex-chatgpt-web doctor
codex-chatgpt-web browser check
codex-chatgpt-web login
codex-chatgpt-web session
```

For local video or audio inspection, Full mode can use `ffprobe`/`ffmpeg` through the same native
command capability it uses for builds and tests. FFmpeg is intentionally not bundled into the
offline installer. Install FFmpeg separately, make sure both `ffmpeg` and `ffprobe` are on `PATH`,
then restart the control center/session. `codex-chatgpt-web doctor` reports a warning when either
binary is missing. A missing binary should be treated as a dependency problem, not as a sandbox or
permission refusal.

If the ChatGPT login has expired, run `codex-chatgpt-web login`, complete sign-in in the dedicated
Chrome window, close that window completely, and start the foreground session again.

### Optional DeepSeek Web

On the control center's **Setup** tab, enable **DeepSeek Web Instant and Expert models**, accept its
separate experimental-automation/data acknowledgement, and run setup. A second dedicated Chrome
profile opens for an ordinary DeepSeek sign-in; close it after the composer is visible. DeepSeek
state is stored independently from ChatGPT state.

The command-line equivalent is:

```powershell
codex-chatgpt-web setup --browser-only `
  --deepseek-web `
  --acknowledge-unofficial `
  --acknowledge-deepseek
```

Use `codex-chatgpt-web deepseek-login` to refresh only that login. DeepSeek models are currently
text-only. In full-harness mode they can request tools advertised by the active Codex turn, which
Codex executes under the task's normal permissions before returning results to DeepSeek on the next
round. Images, uploads, and vision are not exposed through the DeepSeek Web bridge. The automation
does not bypass regional restrictions, WAF challenges, CAPTCHA, or login controls.

## Full harness setup

Full-harness mode connects ChatGPT tool calls back to the current Codex task through an outbound
OpenAI tunnel. The foreground Windows control center/session owns that tunnel; no inbound port or
Windows background service is required.

1. Create a tunnel in the OpenAI Platform tunnel settings.
2. Create a runtime key with **Tunnels Read + Use** permission.
3. Import the runtime key:

   ```powershell
   codex-chatgpt-web tunnel key-import
   ```

4. Configure full mode with the tunnel id:

   ```powershell
   codex-chatgpt-web setup --full `
     --tunnel-id tunnel_0123456789abcdef0123456789abcdef `
     --acknowledge-unofficial
   ```

5. Start the Windows control center/session and confirm readiness:

   ```powershell
   codex-chatgpt-web doctor
   codex-chatgpt-web tunnel status
   ```

6. While the harness reports ready, attach the tunnel to a ChatGPT connector using the exact
   machine-specific name shown by setup (for example, `Codex Native LAPTOP-01`), scan its tools,
   configure the intended action permissions, and restart Codex once.

If you use Full mode on more than one computer, create a separate OpenAI tunnel and a uniquely
named ChatGPT custom app/connector for each computer. Do not point a laptop and desktop at the same
tunnel concurrently: Codex turn capabilities live only in the local broker that created them, while
the shared tunnel can dispatch a tool call to the other computer. The non-owner then reports
`CODEX_SHARED_TUNNEL_ROUTE_MISS` even though both tunnel runtimes are individually healthy.

Unexpected tool approval prompts fail closed unless `--auto-approve-tool-calls` was explicitly
enabled during setup.

## Windows lifecycle

Windows intentionally uses a foreground application/session instead of a persistent service. The
installer does not register automatic startup. Closing the control center stops the proxy, the
full-mode tunnel when configured, and the controlled Chrome instance. Reopen the app and start a
session after Windows login or reboot.

Setup journals the previous Codex route so uninstall can restore it. It refuses to replace a
different route unless `--replace-codex-route` is explicitly supplied, and it refuses unsafe
updates while a task is active.

## Troubleshooting

Run these checks first:

```powershell
codex-chatgpt-web doctor
codex-chatgpt-web browser check
codex-chatgpt-web tunnel status
```

The tunnel status command is relevant only in full-harness mode. If a freshly copied Windows
binary starts slowly during build smoke tests, Windows Defender or another security scanner may be
holding it briefly; rerun the failed smoke test after the scanner releases the file.

If `package:windows` reports an `Offline setup input is missing` error, the path named in the error
must exist before the installer can be embedded. In particular, the offline setup intentionally
embeds this guide as `WINDOWS_SETUP.md` alongside the license and third-party notice files.

## Long sessions and native tool diagnostics (0.2.19)

Full-mode High sessions have no bridge-imposed elapsed-time limit. Active turn bindings,
pending native calls, and browser sessions survive past 24 hours; replay retention only
applies to settled sessions. The Windows session owner requests that automatic idle sleep
be held while it runs, allows the display to turn off, and releases the request on exit.
Keep the harness session and Codex task open. Manual sleep, a reboot, browser sign-out,
network failure, or a ChatGPT service limit can still interrupt work. Clock-advance tests
verify the lifetime rules; they are not a 24-hour authenticated browser soak test.

The primary MCP route is ChatGPT connector → tunnel-client → the packaged `mcp` child → the
active Codex turn's named pipe. The Responses/model route uses port 17841 by default.

For upgrade compatibility, the foreground harness also exposes the same Codex Native MCP tools
through Streamable HTTP at `http://127.0.0.1:17847/v1`. Existing Codex installations that already
have an `[mcp_servers.codex_native]` entry for that URL can keep it enabled; they do not need to be
rewritten just to move to the tunnel/named-pipe architecture. New Full-mode setups still use the
tunnel + packaged stdio MCP child as the primary ChatGPT connector path.

Run `codex-chatgpt-web doctor --json` for local readiness. A successful tunnel check alone
does not prove a browser turn bound: full-mode completion now checks the actual broker
binding. The release smoke additionally initializes the packaged stdio MCP server,
binds a synthetic native environment, and verifies several native tool/result rounds.

The bridge preserves Codex's native command permissions. A real `blocked by policy`
result means the command did not run; changing browser prompts or attaching another
connector cannot grant permission. CLI diagnostics must use the intended task's permission
profile; an empty CLI configuration does not inherit a desktop task's selected profile.

## Uninstall

Use **Uninstall Codex ChatGPT Web...** in the Windows control center or open **Settings > Apps >
Installed apps** and uninstall Codex ChatGPT Web. The removal UI can keep or delete the private
browser/configuration data.

The installed PowerShell uninstaller also supports noninteractive removal. It removes only the
verified runtime, owned shortcuts, exact user PATH entry, documentation, and HKCU uninstall record,
and restores the previous Codex route recorded by setup.

Private state under `%USERPROFILE%\.codex-chatgpt-web` contains browser login material. Do not
share or commit it.
