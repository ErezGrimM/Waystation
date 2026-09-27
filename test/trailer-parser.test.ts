import { describe, expect, test } from "bun:test";
import { parseFixtures, selectionFixtures } from "../src/core/trailerFixtures.ts";
import { asciiLower, parseCommitTrailers, resolveTaskSelection } from "../src/core/trailers.ts";

describe("parseCommitTrailers (A03 fixtures)", () => {
  for (const fixture of parseFixtures) {
    test(fixture.name, () => {
      const result = parseCommitTrailers(fixture.message);
      if (fixture.expect.status === "no_trailer_block") {
        expect(result.status).toBe("no_trailer_block");
        return;
      }
      if (fixture.expect.status === "block") {
        expect(result.status).toBe("block");
        if (result.status !== "block") return;
        expect(result.block.task).toBe(fixture.expect.task);
        expect(result.block.trailers.map((t) => t.key)).toEqual(fixture.expect.keys);
        return;
      }
      expect(result.status).toBe("error");
      if (result.status !== "error") return;
      const kinds = result.errors.map((e) => e.kind).sort();
      expect(kinds).toEqual([...fixture.expect.kinds].sort());
    });
  }
});

describe("resolveTaskSelection (A03 fixtures)", () => {
  for (const fixture of selectionFixtures) {
    test(fixture.name, () => {
      const parse = parseCommitTrailers(fixture.message);
      const result = resolveTaskSelection(parse, fixture.explicit);
      if (fixture.expect.kind === "no_task") {
        expect(result.kind).toBe("no_task");
        return;
      }
      if (fixture.expect.kind === "task") {
        expect(result.kind).toBe("task");
        if (result.kind !== "task") return;
        expect(result.task).toBe(fixture.expect.task);
        expect(result.source).toBe(fixture.expect.source);
        return;
      }
      expect(result.kind).toBe("error");
      if (result.kind !== "error") return;
      expect(result.reason).toBe(fixture.expect.reason);
    });
  }
});

describe("trailer grammar details", () => {
  test("task id value stays exact and case-sensitive", () => {
    const result = parseCommitTrailers("subject\n\nWAYSTATION-TASK: task-ABC");
    expect(result.status).toBe("block");
    if (result.status === "block") {
      expect(result.block.task).toBe("task-ABC");
      const trailer = result.block.trailers[0];
      expect(trailer?.key).toBe("WAYSTATION-TASK");
      expect(trailer?.keyLower).toBe("waystation-task");
    }
  });

  test("unrelated trailer folds a continuation into its value", () => {
    const result = parseCommitTrailers(
      "subject\n\nbody.\n\nRef: ticket ABC\n  continued on the next line",
    );
    expect(result.status).toBe("block");
    if (result.status !== "block") return;
    expect(result.block.task).toBeNull();
    const ref = result.block.trailers.find((t) => t.keyLower === "ref");
    expect(ref?.value).toBe("ticket ABC\n  continued on the next line");
  });

  test("continuation after an unrelated trailer does not break a following task trailer", () => {
    const result = parseCommitTrailers(
      "subject\n\nSigned-off-by: A <a@example.invalid>\n  note\nwaystation-task: task-a",
    );
    expect(result.status).toBe("block");
    if (result.status !== "block") return;
    expect(result.block.task).toBe("task-a");
    expect(result.block.trailers.map((t) => t.keyLower)).toEqual([
      "signed-off-by",
      "waystation-task",
    ]);
  });

  test("CRLF and LF forms parse to identical results", () => {
    const lf = "subject\n\nbody.\n\nwaystation-task: task-a\nSigned-off-by: A <a@example.invalid>";
    const crlf =
      "subject\r\n\r\nbody.\r\n\r\nwaystation-task: task-a\r\nSigned-off-by: A <a@example.invalid>\r\n";
    expect(parseCommitTrailers(crlf)).toEqual(parseCommitTrailers(lf));
  });

  test("the parser is deterministic across repeated calls", () => {
    const message =
      "subject\n\nbody.\n\nWaystation-Task: task-a\nSigned-off-by: A <a@example.invalid>";
    const first = parseCommitTrailers(message);
    for (let i = 0; i < 5; i++) {
      expect(parseCommitTrailers(message)).toEqual(first);
    }
  });

  test("asciiLower folds only ASCII uppercase", () => {
    expect(asciiLower("Waystation-Task")).toBe("waystation-task");
    expect(asciiLower("WAYSTATION-TASK")).toBe("waystation-task");
    expect(asciiLower("Signed-off-by")).toBe("signed-off-by");
    expect(asciiLower("task-ABC")).toBe("task-abc");
  });

  test("a marker that is not a final paragraph is ignored even when a task trailer is absent", () => {
    const result = parseCommitTrailers("subject\n\nWaystation-Task: task-a\n\nwrap-up prose");
    expect(result.status).toBe("no_trailer_block");
  });
});
