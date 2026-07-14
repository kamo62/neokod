#!/usr/bin/env node

/**
 * Regenerates the development and nightly blueprint icon assets from the
 * production Neokod master. Run with: pnpm generate:blueprint-icons
 *
 * This deliberately leaves both non-production channels visually identical:
 * their filenames select the channel while the Neokod artwork stays canonical.
 */

// @effect-diagnostics nodeBuiltinImport:off - Standalone asset-generation script; runs outside any Effect runtime.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import pngToIco from "png-to-ico";
import sharp from "sharp";

import { BRAND_ASSET_PATHS } from "./lib/brand-assets.ts";

const repoRoot = NodeURL.fileURLToPath(new URL("..", import.meta.url));
const sourcePng = NodePath.resolve(repoRoot, "assets/prod/black-universal-1024.png");
const icoSizes = [16, 32, 48, 256] as const;

const pngOutputs = [
  [BRAND_ASSET_PATHS.developmentDesktopIconPng, 1024],
  ["assets/dev/blueprint-universal-1024.png", 1024],
  ["assets/dev/blueprint-ios-1024.png", 1024],
  [BRAND_ASSET_PATHS.developmentWebAppleTouchIconPng, 180],
  [BRAND_ASSET_PATHS.developmentWebFavicon16Png, 16],
  [BRAND_ASSET_PATHS.developmentWebFavicon32Png, 32],
  [BRAND_ASSET_PATHS.nightlyMacIconPng, 1024],
  [BRAND_ASSET_PATHS.nightlyLinuxIconPng, 1024],
  ["assets/nightly/blueprint-ios-1024.png", 1024],
  [BRAND_ASSET_PATHS.nightlyWebAppleTouchIconPng, 180],
  [BRAND_ASSET_PATHS.nightlyWebFavicon16Png, 16],
  [BRAND_ASSET_PATHS.nightlyWebFavicon32Png, 32],
] as const;

const icoOutputs = [
  BRAND_ASSET_PATHS.developmentWindowsIconIco,
  BRAND_ASSET_PATHS.developmentWebFaviconIco,
  BRAND_ASSET_PATHS.nightlyWindowsIconIco,
  BRAND_ASSET_PATHS.nightlyWebFaviconIco,
] as const;

async function writeAsset(relativePath: string, contents: Buffer): Promise<void> {
  const outputPath = NodePath.resolve(repoRoot, relativePath);
  await NodeFSP.mkdir(NodePath.dirname(outputPath), { recursive: true });
  await NodeFSP.writeFile(outputPath, contents);
}

type IconSize = (typeof pngOutputs)[number][1] | (typeof icoSizes)[number];

const pngBySize = new Map<IconSize, Buffer>(
  await Promise.all(
    [...new Set([...pngOutputs.map(([, size]) => size), ...icoSizes])].map(
      async (size) => [size, await sharp(sourcePng).resize(size, size).png().toBuffer()] as const,
    ),
  ),
);

function pngForSize(size: IconSize): Buffer {
  const png = pngBySize.get(size);
  if (!png) throw new Error(`Missing generated ${size}x${size} PNG.`);
  return png;
}

const ico = await pngToIco(icoSizes.map(pngForSize));

await Promise.all([
  ...pngOutputs.map(([path, size]) => writeAsset(path, pngForSize(size))),
  ...icoOutputs.map((path) => writeAsset(path, ico)),
]);
