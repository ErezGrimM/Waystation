import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { GitCommitButton } from "../src/dashboard/client/src/pages/Git.tsx";

test("Git commit control requires an explicit file selection", () => {
  const markup = renderToStaticMarkup(
    createElement(GitCommitButton, { selectedFileCount: 0, onClick: () => {} }),
  );

  expect(markup).toContain("disabled");
  expect(markup).toContain("Select one or more files to commit.");
});

test("Git commit control enables Commit after files are selected", () => {
  const markup = renderToStaticMarkup(
    createElement(GitCommitButton, { selectedFileCount: 2, onClick: () => {} }),
  );

  expect(markup).toContain(">Commit</button>");
  expect(markup).not.toContain("disabled");
  expect(markup).not.toContain("Select one or more files to commit.");
});
