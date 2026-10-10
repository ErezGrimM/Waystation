/**
 * Bun.argv-based CLI parser/dispatcher.
 *
 * Parses process.argv against the typed command specification, handles
 * global options, per-command options, help output, diagnostics, and exit codes.
 */

import { COMMAND_TREE, type CommandContext, type CommandSpec, GLOBAL_OPTIONS } from "./spec.ts";

export interface ParseResult {
  command: CommandSpec | null;
  parent: CommandSpec | null;
  ctx: CommandContext;
  helpRequested: boolean;
  versionRequested: boolean;
  error: string | null;
}

/** Find a command in the tree by path, e.g. ["task", "create"] */
export function findCommand(
  path: string[],
): { command: CommandSpec; parent: CommandSpec | null } | null {
  let current: CommandSpec | null = null;
  let children = COMMAND_TREE;
  for (const segment of path) {
    const next = children.find((c) => c.name === segment);
    if (!next) return null;
    current = next;
    children = current.subcommands;
  }
  return current ? { command: current, parent: null } : null;
}

/** Find a command and its parent by path */
export function findCommandWithParent(
  path: string[],
): { command: CommandSpec; parent: CommandSpec | null } | null {
  if (path.length === 0) return null;
  const parentPath = path.slice(0, -1);
  const name = path[path.length - 1] ?? "";
  const parent = parentPath.length === 0 ? null : (findCommand(parentPath)?.command ?? null);
  const children = parent ? parent.subcommands : COMMAND_TREE;
  const command = children.find((c) => c.name === name);
  if (!command) return null;
  return { command, parent };
}

/** Parse argv (without node/bun and script name) against the command tree */
export function parseArgv(argv: string[]): ParseResult {
  const raw = [...argv];
  let root: string | undefined;
  let json = false;
  let helpRequested = false;
  let versionRequested = false;
  let error: string | null = null;

  // Extract global options from anywhere in argv
  const nonGlobal: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    const arg = raw[i] ?? "";
    if (arg === "--root") {
      const val = raw[i + 1];
      if (val === undefined || val.startsWith("-")) {
        error = "--root requires a value";
        break;
      }
      root = val;
      i++;
    } else if (arg.startsWith("--root=")) {
      root = arg.slice(7);
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "--help" || arg === "-h") {
      helpRequested = true;
    } else if (arg === "--version" || arg === "-v") {
      versionRequested = true;
    } else {
      nonGlobal.push(arg);
    }
  }

  if (error) {
    return {
      command: null,
      parent: null,
      ctx: { opts: {}, args: [], root, json, raw },
      helpRequested,
      versionRequested,
      error,
    };
  }

  // Walk the command tree to find the command path, treating non-matching
  // non-option args as positional arguments
  const path: string[] = [];
  let children = COMMAND_TREE;
  let command: CommandSpec | null = null;
  let parent: CommandSpec | null = null;
  for (const arg of nonGlobal) {
    if (arg.startsWith("-")) continue;
    const next = children.find((c) => c.name === arg);
    if (next) {
      parent = command;
      command = next;
      path.push(arg);
      children = command.subcommands;
    } else {
      break;
    }
  }

  // Parse options for the found command
  const opts: Record<string, string | string[] | boolean | undefined> = {};
  const args: string[] = [];

  if (command) {
    // Build a map of option name -> spec
    const optionMap = new Map<string, (typeof command.options)[number]>();
    for (const opt of command.options) {
      optionMap.set(opt.name, opt);
    }

    // Parse non-global args
    const cmdArgs = nonGlobal.slice(path.length);
    for (let i = 0; i < cmdArgs.length; i++) {
      const arg = cmdArgs[i] ?? "";
      if (arg === "--help" || arg === "-h") {
        helpRequested = true;
        continue;
      }
      if (arg.startsWith("--")) {
        const eqIdx = arg.indexOf("=");
        const kebabName = eqIdx >= 0 ? arg.slice(2, eqIdx) : arg.slice(2);
        // Convert kebab-case to camelCase for lookup
        const name = kebabName.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
        const spec = optionMap.get(name);
        if (!spec) {
          error = `unknown option: --${kebabName}`;
          break;
        }
        if (eqIdx >= 0) {
          // --opt=value form
          if (spec.variadic) {
            const existing = opts[spec.name];
            const val = arg.slice(eqIdx + 1);
            if (Array.isArray(existing)) existing.push(val);
            else opts[spec.name] = [val];
          } else {
            opts[spec.name] = arg.slice(eqIdx + 1);
          }
        } else if (spec.variadic) {
          // Collect values until next option or end
          const values: string[] = [];
          let j = i + 1;
          while (j < cmdArgs.length && !(cmdArgs[j] ?? "").startsWith("-")) {
            values.push(cmdArgs[j] ?? "");
            j++;
          }
          if (values.length === 0) {
            opts[spec.name] = [];
          } else {
            const existing = opts[spec.name];
            if (Array.isArray(existing)) existing.push(...values);
            else opts[spec.name] = values;
          }
          i = j - 1;
        } else if (spec.flag.includes("<") || spec.flag.includes("[")) {
          // Single-value option (has value placeholder)
          const val = cmdArgs[i + 1];
          if (val === undefined || val.startsWith("-")) {
            error = `--${kebabName} requires a value`;
            break;
          }
          opts[spec.name] = val;
          i++;
        } else {
          // Boolean flag (no value placeholder)
          opts[spec.name] = true;
        }
      } else if (arg.startsWith("-") && arg.length > 1) {
        error = `unknown option: ${arg}`;
        break;
      } else {
        args.push(arg);
      }
    }

    // Apply defaults
    if (!error) {
      for (const opt of command.options) {
        if (opts[opt.name] === undefined && opt.default !== undefined) {
          opts[opt.name] = opt.default;
        }
      }
    }
  } else if (path.length > 0 && !helpRequested && !versionRequested) {
    error = `unknown command: ${path.join(" ")}`;
  }

  return {
    command,
    parent,
    ctx: { opts, args, root, json, raw },
    helpRequested,
    versionRequested,
    error,
  };
}

/** Generate help text for a command */
export function generateHelp(command: CommandSpec | null, parent: CommandSpec | null): string {
  const lines: string[] = [];
  const description = command
    ? command.description
    : "Local-first ledger for coordinating humans and AI coding agents";

  lines.push(
    `Usage: waystation ${parent ? `${parent.name} ` : ""}${command ? command.name : "<command>"} [options]`,
  );
  lines.push("");
  lines.push(description);
  lines.push("");

  // Options
  const allOptions = command ? [...command.options] : [];
  if (!command) {
    // Global help
    allOptions.push(...GLOBAL_OPTIONS);
  }

  // Always show --version in global help
  if (!command) {
    allOptions.push({ name: "version", flag: "--version", description: "output version" });
  }

  if (allOptions.length > 0) {
    lines.push("Options:");
    for (const opt of allOptions) {
      const required = opt.required ? " (required)" : "";
      const defaultVal = opt.default !== undefined ? ` (default: ${opt.default})` : "";
      lines.push(`  ${opt.flag.padEnd(30)} ${opt.description}${required}${defaultVal}`);
    }
    lines.push("");
  }

  // Subcommands
  if (command && command.subcommands.length > 0) {
    lines.push("Commands:");
    for (const sub of command.subcommands) {
      lines.push(`  ${sub.name.padEnd(20)} ${sub.description}`);
    }
    lines.push("");
  } else if (!command) {
    lines.push("Commands:");
    for (const cmd of COMMAND_TREE) {
      lines.push(`  ${cmd.name.padEnd(20)} ${cmd.description}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

/** Generate version string */
export function generateVersion(): string {
  return "0.9.0";
}
