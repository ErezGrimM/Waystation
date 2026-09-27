import type { TrailerErrorKind } from "./trailers.ts";

/**
 * Fixtures for acceptance group A03 (plan §16): the deterministic tolerant
 * trailer grammar. Every case in the matrix has a fixture here; the tests in
 * test/trailer-parser.test.ts iterate these.
 */

export type TrailerParseExpect =
  | { status: "no_trailer_block" }
  | { status: "block"; task: string | null; keys: string[] }
  | { status: "error"; kinds: TrailerErrorKind[] };

export interface TrailerParseFixture {
  name: string;
  message: string;
  expect: TrailerParseExpect;
}

export const parseFixtures: TrailerParseFixture[] = [
  {
    name: "mixed-case key accepts and selects the task",
    message: "subject\n\nbody.\n\nWAYSTATION-TASK: task-formatting",
    expect: { status: "block", task: "task-formatting", keys: ["WAYSTATION-TASK"] },
  },
  {
    name: "waystation-task selects an exact case-sensitive task id",
    message: "subject\n\nbody.\n\nwaystation-task: task-ABC",
    expect: { status: "block", task: "task-ABC", keys: ["waystation-task"] },
  },
  {
    name: "plan 5.3 example: trailer plus Signed-off-by",
    message:
      "fix: retain imported formatting\n\nDetails of the change.\n\nwaystation-task: task-formatting\nSigned-off-by: Example Author <author@example.invalid>",
    expect: {
      status: "block",
      task: "task-formatting",
      keys: ["waystation-task", "Signed-off-by"],
    },
  },
  {
    name: "unrelated trailers parse without selecting a task",
    message:
      "subject\n\nbody.\n\nSigned-off-by: A <a@example.invalid>\nCo-authored-by: B <b@example.invalid>",
    expect: { status: "block", task: null, keys: ["Signed-off-by", "Co-authored-by"] },
  },
  {
    name: "unrelated trailer folds a valid continuation",
    message: "subject\n\nbody.\n\nRef: ticket ABC\n  continued on the next line",
    expect: { status: "block", task: null, keys: ["Ref"] },
  },
  {
    name: "duplicate task keys with matching values fail",
    message: "subject\n\nbody.\n\nwaystation-task: task-a\nwaystation-task: task-a",
    expect: { status: "error", kinds: ["duplicate_waystation_task"] },
  },
  {
    name: "duplicate task keys with different capitalization fail",
    message: "subject\n\nbody.\n\nWaystation-Task: task-a\nWAYSTATION-TASK: task-b",
    expect: { status: "error", kinds: ["duplicate_waystation_task"] },
  },
  {
    name: "duplicate task keys with different values fail",
    message: "subject\n\nbody.\n\nwaystation-task: task-a\nwaystation-task: task-b",
    expect: { status: "error", kinds: ["duplicate_waystation_task"] },
  },
  {
    name: "unknown Waystation key is rejected inside the block",
    message: "subject\n\nbody.\n\nWaystation-Foo: bar",
    expect: { status: "error", kinds: ["unknown_waystation_key"] },
  },
  {
    name: "Waystation-Close is always an error inside the block",
    message: "subject\n\nbody.\n\nWaystation-Close: true",
    expect: { status: "error", kinds: ["waystation_close"] },
  },
  {
    name: "empty task id is rejected",
    message: "subject\n\nbody.\n\nwaystation-task:",
    expect: { status: "error", kinds: ["empty_task_id"] },
  },
  {
    name: "whitespace-only task id is rejected",
    message: "subject\n\nbody.\n\nwaystation-task:   ",
    expect: { status: "error", kinds: ["empty_task_id"] },
  },
  {
    name: "task id with spaces is rejected",
    message: "subject\n\nbody.\n\nwaystation-task: task with spaces",
    expect: { status: "error", kinds: ["invalid_task_id"] },
  },
  {
    name: "task id with a slash is rejected",
    message: "subject\n\nbody.\n\nwaystation-task: task/foo",
    expect: { status: "error", kinds: ["invalid_task_id"] },
  },
  {
    name: "traversal task id is rejected",
    message: "subject\n\nbody.\n\nwaystation-task: ..",
    expect: { status: "error", kinds: ["invalid_task_id"] },
  },
  {
    name: "malformed directive without a colon is an error",
    message: "subject\n\nbody.\n\nWaystation-Task task-a",
    expect: { status: "error", kinds: ["malformed_waystation_directive"] },
  },
  {
    name: "naked Waystation directive is a malformed candidate",
    message: "subject\n\nbody.\n\nWaystation : task-a",
    expect: { status: "error", kinds: ["malformed_waystation_directive"] },
  },
  {
    name: "waystation directive continuation is rejected",
    message: "subject\n\nbody.\n\nwaystation-task: task-a\nmore text",
    expect: { status: "error", kinds: ["waystation_continuation"] },
  },
  {
    name: "malformed directive followed by continuation is rejected",
    message: "subject\n\nbody.\n\nWaystation-Task task-a\nmore text",
    expect: {
      status: "error",
      kinds: ["malformed_waystation_directive", "waystation_continuation"],
    },
  },
  {
    name: "unknown Waystation key with a continuation is rejected",
    message: "subject\n\nbody.\n\nWaystation-Foo: bar\ncontinued",
    expect: { status: "error", kinds: ["unknown_waystation_key", "waystation_continuation"] },
  },
  {
    name: "subject alone is never a trailer block",
    message: "waystation-task: task-a",
    expect: { status: "no_trailer_block" },
  },
  {
    name: "subject with no blank separator is never a trailer block",
    message: "subject\nwaystation-task: task-a",
    expect: { status: "no_trailer_block" },
  },
  {
    name: "final ordinary prose paragraph is not reinterpreted",
    message: "subject\n\nbody.\n\nFixed the bug in the parser.",
    expect: { status: "no_trailer_block" },
  },
  {
    name: "marker in an earlier paragraph is ignored (body example)",
    message: "subject\n\nwaystation-task: task-a\n\nThis paragraph documents the format.",
    expect: { status: "no_trailer_block" },
  },
  {
    name: "marker in a contiguous prose paragraph is ignored (body example)",
    message: "subject\n\nFor example:\nwaystation-task: task-a",
    expect: { status: "no_trailer_block" },
  },
  {
    name: "Waystation-Close in an earlier paragraph is ignored",
    message: "subject\n\nWaystation-Close: true\n\nDetails of the change.",
    expect: { status: "no_trailer_block" },
  },
  {
    name: "earlier marker does not conflict with the final marker",
    message: "subject\n\nwaystation-task: task-a\n\nwaystation-task: task-b",
    expect: { status: "block", task: "task-b", keys: ["waystation-task"] },
  },
  {
    name: "trailing blank lines are ignored",
    message: "subject\n\nwaystation-task: task-a\n\n\n",
    expect: { status: "block", task: "task-a", keys: ["waystation-task"] },
  },
  {
    name: "CRLF line endings parse identically",
    message:
      "subject\r\n\r\nbody.\r\n\r\nwaystation-task: task-a\r\nSigned-off-by: A <a@example.invalid>\r\n",
    expect: { status: "block", task: "task-a", keys: ["waystation-task", "Signed-off-by"] },
  },
  {
    name: "lone CR line endings parse identically",
    message: "subject\r\rbody.\r\rwaystation-task: task-a\r",
    expect: { status: "block", task: "task-a", keys: ["waystation-task"] },
  },
  {
    name: "empty message has no trailer block",
    message: "",
    expect: { status: "no_trailer_block" },
  },
  {
    name: "blank-only message has no trailer block",
    message: "\n\n  \n",
    expect: { status: "no_trailer_block" },
  },
];

export interface TrailerSelectionFixture {
  name: string;
  message: string;
  explicit: string | null;
  expect:
    | { kind: "no_task" }
    | { kind: "task"; task: string; source: "trailer" | "explicit" }
    | {
        kind: "error";
        reason: "invalid_final_block" | "explicit_conflict" | "invalid_explicit_task";
      };
}

export const selectionFixtures: TrailerSelectionFixture[] = [
  {
    name: "trailer selects the task",
    message: "subject\n\nwaystation-task: task-a",
    explicit: null,
    expect: { kind: "task", task: "task-a", source: "trailer" },
  },
  {
    name: "explicit task is allowed when no trailer exists",
    message: "subject\n\nbody.",
    explicit: "task-a",
    expect: { kind: "task", task: "task-a", source: "explicit" },
  },
  {
    name: "explicit matching the trailer is accepted and the trailer wins",
    message: "subject\n\nwaystation-task: task-a",
    explicit: "task-a",
    expect: { kind: "task", task: "task-a", source: "trailer" },
  },
  {
    name: "explicit conflicting with the trailer is rejected",
    message: "subject\n\nwaystation-task: task-a",
    explicit: "task-b",
    expect: { kind: "error", reason: "explicit_conflict" },
  },
  {
    name: "explicit conflicting on case is rejected (task ids are case-sensitive)",
    message: "subject\n\nwaystation-task: task-a",
    explicit: "Task-A",
    expect: { kind: "error", reason: "explicit_conflict" },
  },
  {
    name: "no trailer and no explicit selects nothing",
    message: "subject\n\nbody.",
    explicit: null,
    expect: { kind: "no_task" },
  },
  {
    name: "empty explicit selects nothing",
    message: "subject\n\nbody.",
    explicit: "",
    expect: { kind: "no_task" },
  },
  {
    name: "invalid explicit task id is rejected",
    message: "subject\n\nbody.",
    explicit: "task with spaces",
    expect: { kind: "error", reason: "invalid_explicit_task" },
  },
  {
    name: "explicit never bypasses an invalid final block",
    message: "subject\n\nWaystation-Foo: bar",
    explicit: "task-a",
    expect: { kind: "error", reason: "invalid_final_block" },
  },
  {
    name: "explicit never bypasses a duplicate task trailer",
    message: "subject\n\nwaystation-task: task-a\nwaystation-task: task-a",
    explicit: "task-a",
    expect: { kind: "error", reason: "invalid_final_block" },
  },
  {
    name: "explicit is allowed with unrelated-only trailers",
    message: "subject\n\nSigned-off-by: A <a@example.invalid>",
    explicit: "task-a",
    expect: { kind: "task", task: "task-a", source: "explicit" },
  },
  {
    name: "explicit is allowed after a subject-only marker is ignored",
    message: "waystation-task: task-a",
    explicit: "task-a",
    expect: { kind: "task", task: "task-a", source: "explicit" },
  },
];

export type SelectionExpect = (typeof selectionFixtures)[number]["expect"];
