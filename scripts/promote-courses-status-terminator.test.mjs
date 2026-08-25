import { test } from "node:test";
import assert from "node:assert/strict";
import { promoteCoursesStatusTerminator } from "./promote-courses-status-terminator.mjs";

test("replaces one exact legacy PASS and FAIL literal without changing surrounding prompt bytes", () => {
  assert.equal(
    promoteCoursesStatusTerminator(
      "Header — keep spacing\n    @@::PASS::@@  — valid\n    @@::FAIL:reason::@@   — replace reason\nThe REQUIRED DELIMITERS are the literal sequence @@:: at the start and ::@@ at the end. Between them put only PASS or FAIL:reason. Never put the deliverable or any other content inside the status block. Do not prefix it with a label. Output nothing after it.\nFooter\tunchanged"
    ),
    "Header — keep spacing\n    @@::PASS;:&@  — valid\n    @@::FAIL:reason;:&@   — replace reason\nThe REQUIRED DELIMITERS are the literal sequence @@:: at the start and ;:&@ at the end. Between them put only PASS or FAIL:reason. Never put the deliverable or any other content inside the status block. Do not prefix it with a label. Output nothing after it.\nFooter\tunchanged"
  );
});

test("returns an already-promoted prompt byte-for-byte unchanged", () => {
  assert.equal(
    promoteCoursesStatusTerminator(
      "Header\n@@::PASS;:&@\n@@::FAIL:reason;:&@\nThe REQUIRED DELIMITERS are the literal sequence @@:: at the start and ;:&@ at the end. Between them put only PASS or FAIL:reason. Never put the deliverable or any other content inside the status block. Do not prefix it with a label. Output nothing after it.\nFooter"
    ),
    "Header\n@@::PASS;:&@\n@@::FAIL:reason;:&@\nThe REQUIRED DELIMITERS are the literal sequence @@:: at the start and ;:&@ at the end. Between them put only PASS or FAIL:reason. Never put the deliverable or any other content inside the status block. Do not prefix it with a label. Output nothing after it.\nFooter"
  );
});

test("rejects a legacy prompt missing the PASS literal", () => {
  assert.throws(
    () => promoteCoursesStatusTerminator("Header\n@@::FAIL:reason::@@\nThe REQUIRED DELIMITERS are the literal sequence @@:: at the start and ::@@ at the end. Between them put only PASS or FAIL:reason. Never put the deliverable or any other content inside the status block. Do not prefix it with a label. Output nothing after it.\nFooter"),
    /PASS/i
  );
});

test("rejects a legacy prompt missing the FAIL literal", () => {
  assert.throws(
    () => promoteCoursesStatusTerminator("Header\n@@::PASS::@@\nThe REQUIRED DELIMITERS are the literal sequence @@:: at the start and ::@@ at the end. Between them put only PASS or FAIL:reason. Never put the deliverable or any other content inside the status block. Do not prefix it with a label. Output nothing after it.\nFooter"),
    /FAIL/i
  );
});

test("rejects a legacy prompt containing an extra PASS literal", () => {
  assert.throws(
    () => promoteCoursesStatusTerminator(
      "@@::PASS::@@\n@@::PASS::@@\n@@::FAIL:reason::@@\nThe REQUIRED DELIMITERS are the literal sequence @@:: at the start and ::@@ at the end. Between them put only PASS or FAIL:reason. Never put the deliverable or any other content inside the status block. Do not prefix it with a label. Output nothing after it."
    ),
    /PASS/i
  );
});

test("rejects a legacy prompt containing an extra FAIL literal", () => {
  assert.throws(
    () => promoteCoursesStatusTerminator(
      "@@::PASS::@@\n@@::FAIL:reason::@@\n@@::FAIL:reason::@@\nThe REQUIRED DELIMITERS are the literal sequence @@:: at the start and ::@@ at the end. Between them put only PASS or FAIL:reason. Never put the deliverable or any other content inside the status block. Do not prefix it with a label. Output nothing after it."
    ),
    /FAIL/i
  );
});

test("rejects a partially promoted prompt instead of guessing its migration state", () => {
  assert.throws(
    () => promoteCoursesStatusTerminator(
      "@@::PASS;:&@\n@@::FAIL:reason::@@\nThe REQUIRED DELIMITERS are the literal sequence @@:: at the start and ;:&@ at the end. Between them put only PASS or FAIL:reason. Never put the deliverable or any other content inside the status block. Do not prefix it with a label. Output nothing after it."
    ),
    /PASS/i
  );
});

test("does not replace similar non-contract text while promoting the exact literals", () => {
  assert.equal(
    promoteCoursesStatusTerminator(
      "Example @@::PASS ::@@ remains\n@@::PASS::@@\n@@::FAIL:reason::@@\nThe REQUIRED DELIMITERS are the literal sequence @@:: at the start and ::@@ at the end. Between them put only PASS or FAIL:reason. Never put the deliverable or any other content inside the status block. Do not prefix it with a label. Output nothing after it.\nExample @@::FAIL:<reason>::@@ remains"
    ),
    "Example @@::PASS ::@@ remains\n@@::PASS;:&@\n@@::FAIL:reason;:&@\nThe REQUIRED DELIMITERS are the literal sequence @@:: at the start and ;:&@ at the end. Between them put only PASS or FAIL:reason. Never put the deliverable or any other content inside the status block. Do not prefix it with a label. Output nothing after it.\nExample @@::FAIL:<reason>::@@ remains"
  );
});

test("rejects a legacy prompt missing the exact closing-delimiter prose", () => {
  assert.throws(
    () => promoteCoursesStatusTerminator("@@::PASS::@@\n@@::FAIL:reason::@@"),
    /delimiter|prose|contract/i
  );
});

test("rejects a legacy prompt containing duplicate closing-delimiter prose", () => {
  assert.throws(
    () => promoteCoursesStatusTerminator(
      "@@::PASS::@@\n@@::FAIL:reason::@@\nThe REQUIRED DELIMITERS are the literal sequence @@:: at the start and ::@@ at the end. Between them put only PASS or FAIL:reason. Never put the deliverable or any other content inside the status block. Do not prefix it with a label. Output nothing after it.\nThe REQUIRED DELIMITERS are the literal sequence @@:: at the start and ::@@ at the end. Between them put only PASS or FAIL:reason. Never put the deliverable or any other content inside the status block. Do not prefix it with a label. Output nothing after it."
    ),
    /delimiter|prose|contract/i
  );
});

test("rejects new token examples paired with legacy closing-delimiter prose", () => {
  assert.throws(
    () => promoteCoursesStatusTerminator(
      "@@::PASS;:&@\n@@::FAIL:reason;:&@\nThe REQUIRED DELIMITERS are the literal sequence @@:: at the start and ::@@ at the end. Between them put only PASS or FAIL:reason. Never put the deliverable or any other content inside the status block. Do not prefix it with a label. Output nothing after it."
    ),
    /delimiter|prose|contract/i
  );
});
