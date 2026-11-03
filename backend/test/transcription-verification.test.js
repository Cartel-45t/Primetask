"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const verify = require("../src/services/verifyTranscriptionSubmission");

const reference = [
  "Title: Regional Planning Meeting",
  "",
  "Speaker 1: Good morning, everyone. Welcome to today's meeting.",
  "",
  "Speaker 2: Thank you. We will begin with the first agenda item.",
  "",
  "The committee discussed the proposed regional development plan.",
  "",
  "Prepared by: Secretariat",
  "Footer: End of transcript"
].join("\n");

test("accepts equivalent wording with the same transcript structure", () => {
  const submitted = [
    "Title: Regional Planning Meeting",
    "",
    "Speaker 1: Greetings, colleagues. It is time to begin.",
    "",
    "Speaker 2: Thank you. Let us start with our opening agenda item.",
    "",
    "The committee reviewed plans for development across the region.",
    "",
    "Prepared by: Secretariat",
    "Footer: End of transcript"
  ].join("\n");

  const result = verify({
    referenceTranscript: reference,
    transcriptText: submitted
  });

  assert.equal(result.passed, true);
});

test("accepts equivalent section headings", () => {
  const ref = "Title: Meeting\n\nAttendees: Five members\n\nThe meeting began at nine.";
  const submitted = "Title: Meeting\n\nParticipants: Five members\n\nThe session began at nine.";

  const result = verify({
    referenceTranscript: ref,
    transcriptText: submitted
  });

  assert.equal(result.passed, true);
});

test("rejects a submission that removes required paragraph separation", () => {
  const result = verify({
    referenceTranscript: "First paragraph has content.\n\nSecond paragraph has content.",
    transcriptText: "First paragraph has content. Second paragraph has content."
  });

  assert.equal(result.checks.find(x => x.check === "paragraph_structure").passed, false);
});

test("rejects missing speaker labels when the reference uses them", () => {
  const result = verify({
    referenceTranscript: "Speaker 1: Welcome everyone.\n\nSpeaker 2: Thank you.",
    transcriptText: "Welcome everyone.\n\nThank you."
  });

  assert.equal(result.checks.find(x => x.check === "speaker_labels").passed, false);
});

test("does not mistake ordinary capitalized sentences for speaker labels", () => {
  const result = verify({
    referenceTranscript: "The Chair: Welcome everyone.\n\nThe Secretary: Thank you.",
    transcriptText: "The meeting opened with a welcome.\n\nThe secretary gave thanks."
  });

  assert.equal(result.checks.find(x => x.check === "speaker_labels").passed, false);
});

test("rejects missing timestamps when required by the reference", () => {
  const result = verify({
    referenceTranscript: "[00:00] Welcome.\n\n[00:10] Thank you.",
    transcriptText: "Welcome.\n\nThank you."
  });

  assert.equal(result.checks.find(x => x.check === "timestamp_structure").passed, false);
});

test("rejects missing required headings", () => {
  const result = verify({
    referenceTranscript: "Title: Meeting\n\nPrepared by: Admin\n\nThe meeting began.",
    transcriptText: "Title: Meeting\n\nThe meeting began."
  });

  assert.equal(result.checks.find(x => x.check === "headings_and_sections").passed, false);
});

test("rejects severely reduced sentence punctuation", () => {
  const result = verify({
    referenceTranscript: "One sentence. Two sentences. Three sentences. Four sentences. Five sentences.",
    transcriptText: "One sentence two sentences three sentences four sentences five sentences"
  });

  assert.equal(result.checks.find(x => x.check === "punctuation").passed, false);
});

test("rejects unbalanced brackets", () => {
  const result = verify({
    referenceTranscript: "The committee met.",
    transcriptText: "The committee met (today."
  });

  assert.equal(result.checks.find(x => x.check === "balanced_brackets").passed, false);
});

test("does not pass when either transcript is empty", () => {
  const result = verify({
    referenceTranscript: reference,
    transcriptText: ""
  });

  assert.equal(result.passed, false);
});
