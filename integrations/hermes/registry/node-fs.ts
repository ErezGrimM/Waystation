import { realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import type { RegistryFilesystem } from "./registry.ts";

/**
 * Filesystem adapter for the project registry.
 *
 * - Canonicalizes paths with realpath so Windows junctions and symlinks resolve
 *   to the same underlying directory.
 * - Uses filesystem-resolved casing, retaining distinctions in case-sensitive
 *   directories instead of blindly lowercasing paths.
 */
export const nodeRegistryFilesystem: RegistryFilesystem = {
  async canonicalize(rawPath: string): Promise<string> {
    return await realpath(rawPath);
  },

  async rootExists(rawPath: string): Promise<boolean> {
    try {
      const info = await stat(join(rawPath, ".waystation"));
      return info.isDirectory();
    } catch {
      return false;
    }
  },
};
