# Reconnecting fix for the 0.2.19 Windows harness

The failing installed 0.2.19 runtime was reproduced locally using its own Node
executable and Responses bridge over HTTP. With no stall timeout in config,
the bridge terminated a quiet tool round with `upstream_stall_timeout` after
about four seconds. The source used `0` to mean disabled but compared its tick
counter against that zero deadline. Browser heartbeats were also consumed
without being forwarded to Codex, and hidden reasoning suppressed keepalives.

The correction is in `src/bridge.ts` and `src/stall-timeout.ts`: a disabled
watchdog has no deadline, positive deadlines use elapsed time, adapter
heartbeats reach the SSE client, and cancellation cannot persist a late
completion. The ChatGPT bootstrap heartbeat now runs every two seconds.

## Installing

Use `dist/codex-chatgpt-web-0.2.19-reconnect-fixed-setup.exe`. Close the harness
session/control center before installing, then start the harness and reopen
Codex. No deletion of browser data or configuration is needed. If uninstalling
first, choose **Keep data**.

This is a corrected build of 0.2.19, so the displayed application version is
still 0.2.19. Its runtime manifest now records `builtAt`, `sourceSha256`, and
`entrypointSha256`; the installer filename and accompanying SHA-256 distinguish
it from the original 0.2.19 build. The old installer is backed up as
`dist/codex-chatgpt-web-0.2.19-before-reconnect-fix.exe`.

## What happens to retained settings

The file installer replaces the runtime and launcher paths while retaining
private configuration/browser files. Setup refreshes the saved release and
runtime command when necessary. Retaining data was not the cause of the
reproduced failure: the original runtime failed with an absent watchdog setting.
The web response route does not use an old saved `stallTimeoutSec` to terminate
browser/tool waits, and zero remains a supported disabled watchdog value.

## Verification

`bun run build:windows:installer` now verifies source/payload fingerprints and
runs a 6.2-second quiet tool round through the actual packaged Node HTTP stream.
The original installed bundle fails that test; the corrected build completes
the tool round and continues emitting heartbeat frames.

`bun run smoke:installer` tests an isolated uninstall with Keep Data followed by
reinstallation. It checks byte-for-byte retention of synthetic config/browser
files, the reinstalled entrypoint fingerprint, and the reinstalled HTTP stream.
The tests do not access a real browser login or submit a model request.
