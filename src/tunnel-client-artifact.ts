export const TUNNEL_CLIENT_UPSTREAM_VERSION = "0.0.12";
export const TUNNEL_CLIENT_UPSTREAM_COMMIT = "881c9a8fed7cccbe6607cd419863bbca506b8215";
export const TUNNEL_CLIENT_BUILD_ID = "0.0.12-codexweb-no-expiry.1";

export const TUNNEL_CLIENT_TARGETS = {
  "windows-amd64": {
    key: "windows-amd64",
    platform: "win32",
    arch: "x64",
    goos: "windows",
    goarch: "amd64",
    binaryName: "tunnel-client.exe",
    binarySha256: "cb34bc186aff6eae8525cafb7dc5b81ec1b451f6133c23b1a5e9a4284e3f0c88",
  },
  "windows-arm64": {
    key: "windows-arm64",
    platform: "win32",
    arch: "arm64",
    goos: "windows",
    goarch: "arm64",
    binaryName: "tunnel-client.exe",
    binarySha256: "4520165564fd65d2947919e4e1ee99b53d016236ad4948094e713e70a702877f",
  },
  "darwin-amd64": {
    key: "darwin-amd64",
    platform: "darwin",
    arch: "x64",
    goos: "darwin",
    goarch: "amd64",
    binaryName: "tunnel-client",
    binarySha256: "a746b82a915f1822da515113b292c26cadf16f9de6791345bbe2376a02d0363d",
  },
  "darwin-arm64": {
    key: "darwin-arm64",
    platform: "darwin",
    arch: "arm64",
    goos: "darwin",
    goarch: "arm64",
    binaryName: "tunnel-client",
    binarySha256: "cc08e39fe17a5a7a53539a3b9dd4584e1029580442fa0632b4e8de472c09a7ce",
  },
} as const;

export type TunnelClientTargetKey = keyof typeof TUNNEL_CLIENT_TARGETS;
export type TunnelClientTarget = (typeof TUNNEL_CLIENT_TARGETS)[TunnelClientTargetKey];

export function tunnelClientTargetFor(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): TunnelClientTarget | undefined {
  return Object.values(TUNNEL_CLIENT_TARGETS).find(target => (
    target.platform === platform && target.arch === arch
  ));
}

export function requireTunnelClientTarget(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): TunnelClientTarget {
  const target = tunnelClientTargetFor(platform, arch);
  if (!target) throw new Error(`The bundled no-expiry tunnel-client does not support ${platform}/${arch}`);
  return target;
}

export function tunnelClientVendorPath(target: TunnelClientTarget): string {
  return `vendor/tunnel-client/${target.binaryName}`;
}
