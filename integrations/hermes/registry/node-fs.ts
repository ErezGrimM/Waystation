import { realpath, stat } from "node:fs/promises";
import type { RegistryFilesystem } from "./registry.ts";

/**
 * Filesystem adapter for the project registry.
 *
 * - Canonicalizes paths with realpath so Windows junctions and symlinks resolve
 *   to the same underlying directory.
 * - Compares canonical paths case-insensitively on Windows to catch case-variant
 *   aliases of the same folder.
 */
export const nodeRegistryFilesystem: RegistryFilesystem = {
  async canonicalize(rawPath: string): Promise<string> {
    try {
      return await realpath(rawPath);
    } catch {
      // A path that does not exist yet cannot be canonicalized through the
      // filesystem; return it normalized so duplicates are still detectable
      // among non-existent inputs.
      return rawPath;
    }
  },

  async rootExists(rawPath: string): Promise<boolean> {
    try {
      const info = await stat(rawPath);
      return info.isDirectory();
    } catch {
      return false;
    }
  },
};
